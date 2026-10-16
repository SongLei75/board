#include <node_api.h>
#include <wolfssl/options.h>
#include <wolfssh/ssh.h>
#include <wolfssh/port.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <sys/socket.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <unistd.h>
#endif
#include <cerrno>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
#ifdef _WIN32
// MinGW cannot use MSVC's delay-load hook. Resolve the Node-API entry points
// from the current Node/Electron host without linking against node.exe.
template<typename Fn>
Fn hostSymbol(const char* name) {
    FARPROC address = GetProcAddress(GetModuleHandleW(nullptr), name);
    if (!address) throw std::runtime_error(std::string("Missing Node-API symbol: ") + name);
    static_assert(sizeof(Fn) == sizeof(address));
    Fn result;
    std::memcpy(&result, &address, sizeof(result));
    return result;
}
#define NAPI(name) ([] { static auto fn = hostSymbol<decltype(&name)>(#name); return fn; }())
#else
#define NAPI(name) name
#endif
#ifdef _WIN32
using NativeSocket = SOCKET;
constexpr NativeSocket invalidSocket = INVALID_SOCKET;
int socketError() { return WSAGetLastError(); }
void closeSocket(NativeSocket socket) { closesocket(socket); }
bool connecting(int result, int error) {
    return result == 0 || error == WSAEWOULDBLOCK || error == WSAEINPROGRESS;
}
std::string socketErrorText(int error) { return "Winsock error " + std::to_string(error); }
#else
using NativeSocket = int;
constexpr NativeSocket invalidSocket = -1;
int socketError() { return errno; }
void closeSocket(NativeSocket socket) { ::close(socket); }
bool connecting(int result, int error) { return result == 0 || error == EINPROGRESS; }
std::string socketErrorText(int error) { return strerror(error); }
#endif
void check(napi_status status) {
    if (status != napi_ok) throw std::runtime_error("Invalid native addon argument");
}
void requireSuccess(int result, const char* action) {
    if (result != WS_SUCCESS)
        throw std::runtime_error(std::string(action) + ": " + wolfSSH_ErrorToName(result));
}

struct Session {
    NativeSocket fd = invalidSocket;
    bool connected = false;
    bool ready = false;
    WOLFSSH_CTX* ctx = nullptr;
    WOLFSSH* ssh = nullptr;
    byte* key = nullptr;
    word32 keySize = 0;
    byte* certificates = nullptr;
    word32 certificatesSize = 0;
    std::string algorithm;

    void close() {
        if (ssh) { wolfSSH_free(ssh); ssh = nullptr; }
        if (ctx) { wolfSSH_CTX_free(ctx); ctx = nullptr; }
        if (fd != invalidSocket) {
#ifdef _WIN32
            ::shutdown(fd, SD_BOTH);
#else
            ::shutdown(fd, SHUT_RDWR);
#endif
            closeSocket(fd);
            fd = invalidSocket;
        }
        if (key) {
            volatile byte* p = key;
            for (word32 i = 0; i < keySize; i++) p[i] = 0;
            WFREE(key, nullptr, 0);
            key = nullptr;
        }
        if (certificates) {
            WFREE(certificates, nullptr, 0);
            certificates = nullptr;
        }
    }
    ~Session() { close(); }
};

int authenticate(byte type, WS_UserAuthData* auth, void* context) {
    if (type != WOLFSSH_USERAUTH_PUBLICKEY) return WOLFSSH_USERAUTH_FAILURE;
    auto* session = static_cast<Session*>(context);
    auto& key = auth->sf.publicKey;
    key.publicKeyType = reinterpret_cast<const byte*>(session->algorithm.data());
    key.publicKeyTypeSz = session->algorithm.size();
    key.publicKey = session->certificates;
    key.publicKeySz = session->certificatesSize;
    key.privateKey = session->key;
    key.privateKeySz = session->keySize;
    key.isCert = 1;
    return WOLFSSH_USERAUTH_SUCCESS;
}

void loadIdentity(Session& session, const byte* data, size_t size) {
    const byte* type = nullptr;
    word32 typeSize = 0;
    requireSuccess(wolfSSH_ReadKey_buffer(data, size, WOLFSSH_FORMAT_PEM,
        &session.key, &session.keySize, &type, &typeSize, nullptr), "Read identity private key");
    std::string keyType(reinterpret_cast<const char*>(type), typeSize);
    if (keyType != "ssh-rsa" && keyType != "ecdsa-sha2-nistp256" &&
        keyType != "ecdsa-sha2-nistp384" && keyType != "ecdsa-sha2-nistp521")
        throw std::runtime_error("Unsupported X.509 private key algorithm");
    session.algorithm = "x509v3-" + keyType;
    requireSuccess(wolfSSH_ReadCerts_buffer(data, size, WOLFSSH_FORMAT_PEM,
        &session.certificates, &session.certificatesSize, nullptr),
        "Read identity certificate chain");
}

std::string stringArgument(napi_env env, napi_value value) {
    size_t size = 0;
    check(NAPI(napi_get_value_string_utf8)(env, value, nullptr, 0, &size));
    std::vector<char> data(size + 1);
    check(NAPI(napi_get_value_string_utf8)(env, value, data.data(), data.size(), &size));
    return std::string(data.data(), size);
}
Session* sessionArgument(napi_env env, napi_value value) {
    void* data = nullptr;
    check(NAPI(napi_get_value_external)(env, value, &data));
    return static_cast<Session*>(data);
}
std::vector<napi_value> arguments(napi_env env, napi_callback_info info, size_t count) {
    std::vector<napi_value> values(count);
    size_t actual = count;
    check(NAPI(napi_get_cb_info)(env, info, &actual, values.data(), nullptr, nullptr));
    if (actual != count) throw std::runtime_error("Wrong native addon argument count");
    return values;
}
bool retry(Session& session, int result) {
    int error = result == WS_ERROR || result == WS_FATAL_ERROR ? wolfSSH_get_error(session.ssh) : result;
    if (error == WS_REKEYING) {
        word32 channel;
        const int status = wolfSSH_worker(session.ssh, &channel);
        if (status == WS_SUCCESS || status == WS_CHAN_RXD) return true;
        error = status == WS_ERROR || status == WS_FATAL_ERROR ? wolfSSH_get_error(session.ssh) : status;
    }
    if (error == WS_WANT_READ || error == WS_WANT_WRITE || error == WS_REKEYING || error == WS_WINDOW_FULL)
        return true;
    requireSuccess(error, "wolfSSH I/O");
    return false;
}

napi_value create(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 4);
        const auto host = stringArgument(env, args[0]);
        int32_t port;
        check(NAPI(napi_get_value_int32)(env, args[1], &port));
        const auto username = stringArgument(env, args[2]);
        void* pem;
        size_t size;
        check(NAPI(napi_get_buffer_info)(env, args[3], &pem, &size));
        auto session = std::make_unique<Session>();
        loadIdentity(*session, static_cast<byte*>(pem), size);
        session->ctx = wolfSSH_CTX_new(WOLFSSH_ENDPOINT_CLIENT, nullptr);
        if (!session->ctx) throw std::runtime_error("Cannot allocate wolfSSH context");
        wolfSSH_SetUserAuth(session->ctx, authenticate);
        // The v1 API supplies endpoints but no server trust material. Match ssh2's
        // default policy; host pinning is not claimed by this package.
        wolfSSH_CTX_SetPublicKeyCheck(session->ctx, [](const byte*, word32, void*) -> int {
            return WS_SUCCESS;
        });
        session->ssh = wolfSSH_new(session->ctx);
        if (!session->ssh) throw std::runtime_error("Cannot allocate wolfSSH session");
        wolfSSH_SetUserAuthCtx(session->ssh, session.get());
        requireSuccess(wolfSSH_SetUsername(session->ssh, username.c_str()), "Set username");
        requireSuccess(wolfSSH_SetChannelType(session->ssh, WOLFSSH_SESSION_TERMINAL, nullptr, 0), "Request terminal");
        // This list covers server host keys too; client authentication itself is X.509 only.
        requireSuccess(wolfSSH_SetAlgoListKey(session->ssh,
            "x509v3-ecdsa-sha2-nistp256,x509v3-ecdsa-sha2-nistp384,x509v3-ecdsa-sha2-nistp521,"
            "x509v3-ssh-rsa,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,"
            "ssh-ed25519,rsa-sha2-256,rsa-sha2-512,ssh-rsa"), "Set key algorithms");
        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        addrinfo* addresses = nullptr;
        const int status = getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &addresses);
        if (status != 0) throw std::runtime_error(std::string("Resolve board: ") + gai_strerror(status));
        std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> addressGuard(addresses, freeaddrinfo);
        int lastError = 0;
        for (auto* address = addresses; address; address = address->ai_next) {
#ifdef _WIN32
            const NativeSocket fd = socket(address->ai_family, SOCK_STREAM, IPPROTO_TCP);
            if (fd == invalidSocket) { lastError = socketError(); continue; }
            u_long nonBlocking = 1;
            if (ioctlsocket(fd, FIONBIO, &nonBlocking) != 0) {
                lastError = socketError(); closeSocket(fd); continue;
            }
#else
            const NativeSocket fd = socket(address->ai_family, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
            if (fd == invalidSocket) { lastError = socketError(); continue; }
#endif
            int one = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof(one));
            setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, reinterpret_cast<const char*>(&one), sizeof(one));
            const int result = connect(fd, address->ai_addr, address->ai_addrlen);
            lastError = result == 0 ? 0 : socketError();
            if (connecting(result, lastError)) {
                session->fd = fd;
                session->connected = result == 0;
                break;
            }
            closeSocket(fd);
        }
        if (session->fd == invalidSocket) throw std::runtime_error(std::string("Connect board: ") + socketErrorText(lastError));
        requireSuccess(wolfSSH_set_fd(session->ssh, session->fd), "Attach board socket");
        napi_value result;
        check(NAPI(napi_create_external)(env, session.get(), [](napi_env, void* data, void*) {
            delete static_cast<Session*>(data);
        }, nullptr, &result));
        session.release();
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value handshake(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 1);
        auto& session = *sessionArgument(env, args[0]);
        if (session.fd == invalidSocket) throw std::runtime_error("Native session is closed");
        if (!session.connected) {
#ifdef _WIN32
            fd_set writable;
            FD_ZERO(&writable);
            FD_SET(session.fd, &writable);
            timeval instant{0, 0};
            const int status = select(0, nullptr, &writable, nullptr, &instant);
            if (status == SOCKET_ERROR) throw std::runtime_error("Cannot select board socket");
#else
            pollfd descriptor{session.fd, POLLOUT, 0};
            const int status = poll(&descriptor, 1, 0);
            if (status < 0 && errno != EINTR) throw std::runtime_error("Cannot poll board socket");
#endif
            if (status > 0) {
                int error = 0;
#ifdef _WIN32
                int length = sizeof(error);
                if (getsockopt(session.fd, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &length) != 0)
                    error = socketError();
#else
                socklen_t length = sizeof(error);
                if (getsockopt(session.fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0) error = socketError();
#endif
                if (error) throw std::runtime_error(std::string("Connect board: ") + socketErrorText(error));
                session.connected = true;
            }
        }
        if (session.connected && !session.ready) {
            const int status = wolfSSH_connect(session.ssh);
            if (status == WS_SUCCESS) session.ready = true;
            else retry(session, status);
        }
        napi_value result;
        check(NAPI(napi_get_boolean)(env, session.ready, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value read(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 1);
        auto& session = *sessionArgument(env, args[0]);
        if (!session.ssh) throw std::runtime_error("Native session is closed");
        byte data[32768];
        int count = wolfSSH_stream_read(session.ssh, data, sizeof(data));
        if (count < 0) {
            const int error = wolfSSH_get_error(session.ssh);
            if (count == WS_EOF || count == WS_CHANNEL_CLOSED || error == WS_EOF || error == WS_CHANNEL_CLOSED) {
                napi_value result;
                check(NAPI(napi_get_null)(env, &result));
                return result;
            }
            if (count == WS_EXTDATA || error == WS_EXTDATA)
                count = wolfSSH_extended_data_read(session.ssh, data, sizeof(data));
            else {
                retry(session, count);
                // stream_send can consume bytes while a packet is still waiting
                // for socket writability. Service it even with no queued input.
                word32 channel = 0;
                const int status = wolfSSH_worker(session.ssh, &channel);
                if (status != WS_SUCCESS && status != WS_CHAN_RXD && status != WS_EXTDATA)
                    retry(session, status);
                count = 0;
            }
        }
        if (count < 0) { retry(session, count); count = 0; }
        napi_value result;
        check(NAPI(napi_create_buffer_copy)(env, count, data, nullptr, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value write(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 2);
        auto& session = *sessionArgument(env, args[0]);
        if (!session.ssh) throw std::runtime_error("Native session is closed");
        void* data;
        size_t size;
        check(NAPI(napi_get_buffer_info)(env, args[1], &data, &size));
        int count = wolfSSH_stream_send(session.ssh, static_cast<byte*>(data), size > 32768 ? 32768 : size);
        if (count < 0) { retry(session, count); count = 0; }
        napi_value result;
        check(NAPI(napi_create_int32)(env, count, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value close(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 1);
        sessionArgument(env, args[0])->close();
        napi_value result;
        check(NAPI(napi_get_undefined)(env, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value initialize(napi_env env, napi_value exports) {
    try {
        static std::once_flag initialized;
        std::call_once(initialized, [] {
#ifdef _WIN32
            WSADATA winsock;
            if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0)
                throw std::runtime_error("Initialize Winsock");
#endif
            requireSuccess(wolfSSH_Init(), "Initialize wolfSSH");
        });
        const napi_property_descriptor methods[] = {
            {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"handshake", nullptr, handshake, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"read", nullptr, read, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"write", nullptr, write, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr},
        };
        check(NAPI(napi_define_properties)(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
        return exports;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}
} // namespace
NAPI_MODULE(board_session, initialize)

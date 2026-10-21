#include <node_api.h>
#include <wolfssl/options.h>
#include <wolfssh/ssh.h>
#include <wolfssh/port.h>
#include <wolfssh/wolfscp.h>

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
#include <algorithm>
#include <cerrno>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <limits>
#include <cstring>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

// Filesystem callbacks only. wolfSSH owns the SCP protocol and transfer buffers.
class ScpFiles {
public:
    ScpFiles(const std::string& local, bool upload);
    void attach(WOLFSSH_CTX* ctx, WOLFSSH* ssh);
    bool complete() const;
    std::string error;
private:
    struct Directory {
        std::filesystem::path canonical;
        std::filesystem::directory_iterator next;
    };
    std::filesystem::path root;
    bool started = false;
    bool finished = false;
    std::vector<Directory> sending;
    std::vector<std::filesystem::path> receiving;
    std::ifstream input;
    std::ofstream output;
    uint64_t received = 0;
    uint32_t expected = 0;
    int send(int state, char* name, word32 nameSize, int* mode,
        word32* size, byte* buffer, word32 capacity);
    int receive(int state, const char* name, word32 size, byte* buffer, word32 count);
    static int sendCallback(WOLFSSH*, int, const char*, char*, word32,
        word64*, word64*, int*, word32, word32*, byte*, word32, void*);
    static int receiveCallback(WOLFSSH*, int, const char*, const char*, int,
        word64, word64, word32, byte*, word32, word32, void*);
};

namespace fs = std::filesystem;
namespace {
constexpr size_t maxDepth = 128;
void validName(const std::string& name) {
    if (name.empty() || name == "." || name == ".." ||
        name.find_first_of("/\\:\r\n") != std::string::npos ||
        name.find('\0') != std::string::npos)
        throw std::runtime_error("Invalid SCP entry name");
#ifdef _WIN32
    if (name.back() == '.' || name.back() == ' ' || name.find_first_of("<>\"|?*") != std::string::npos)
        throw std::runtime_error("Unsupported Windows SCP entry name");
    auto stem = name.substr(0, name.find('.'));
    std::transform(stem.begin(), stem.end(), stem.begin(), [](unsigned char ch) {
        return static_cast<char>(std::toupper(ch));
    });
    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
        (stem.size() == 4 && (stem.substr(0, 3) == "COM" || stem.substr(0, 3) == "LPT") &&
         stem[3] >= '0' && stem[3] <= '9'))
        throw std::runtime_error("Reserved Windows SCP entry name");
#endif
}
void destination(const fs::path& path) {
    // Never follow an existing destination link outside the selected tree.
    if (fs::is_symlink(fs::symlink_status(path)))
        throw std::runtime_error("SCP destination is a symbolic link: " + path.u8string());
}
}

ScpFiles::ScpFiles(const std::string& local, bool upload) : root(fs::u8path(local)) {
    if (!root.is_absolute()) throw std::runtime_error("SCP local path must be absolute");
    if (!upload) {
        root = fs::canonical(root.parent_path()) / root.filename();
        destination(root);
    }
}

void ScpFiles::attach(WOLFSSH_CTX* ctx, WOLFSSH* ssh) {
    wolfSSH_SetScpSend(ctx, sendCallback);
    wolfSSH_SetScpRecv(ctx, receiveCallback);
    wolfSSH_SetScpSendCtx(ssh, this);
    wolfSSH_SetScpRecvCtx(ssh, this);
}

bool ScpFiles::complete() const {
    return error.empty() && started && finished && receiving.empty() && !output.is_open();
}

int ScpFiles::send(int state, char* name, word32 nameSize, int* mode,
        word32* size, byte* buffer, word32 capacity) {
    if (state == WOLFSSH_SCP_NEW_REQUEST) return WS_SCP_CONTINUE;
    if (state != WOLFSSH_SCP_CONTINUE_FILE_TRANSFER) {
        fs::path path;
        if (!started) {
            path = root;
            started = true;
        } else if (!sending.empty()) {
            auto& directory = sending.back();
            if (directory.next == fs::directory_iterator{}) {
                sending.pop_back();
                if (sending.empty()) { finished = true; return WS_SCP_EXIT_DIR_FINAL; }
                return WS_SCP_EXIT_DIR;
            }
            path = directory.next->path();
            ++directory.next;
        } else {
            finished = true;
            return WS_SCP_COMPLETE;
        }
        const auto filename = path.filename().u8string();
        validName(filename);
        if (filename.size() >= nameSize) throw std::runtime_error("SCP filename is too long");
        std::memcpy(name, filename.c_str(), filename.size() + 1);
        const auto status = fs::status(path); // Follow source links, as scp -r does.
        if (!fs::exists(status)) throw std::runtime_error("SCP source does not exist: " + path.u8string());
        *mode = static_cast<int>(status.permissions()) & 0777;
        if (fs::is_directory(status)) {
            auto canonical = fs::canonical(path);
            if (sending.size() >= maxDepth || std::any_of(sending.begin(), sending.end(),
                    [&](const Directory& parent) { return parent.canonical == canonical; }))
                throw std::runtime_error("SCP source directory cycle or depth limit (128)");
            sending.push_back({canonical, fs::directory_iterator(path)});
            *size = 0;
            return WS_SCP_ENTER_DIR;
        }
        if (!fs::is_regular_file(status)) throw std::runtime_error("SCP source is not a regular file or directory");
        const auto length = fs::file_size(path);
        if (length > std::numeric_limits<word32>::max())
            throw std::runtime_error("SCP files larger than 4 GiB minus 1 byte are unsupported");
        *size = static_cast<word32>(length);
        expected = *size;
        received = 0;
        input.open(path, std::ios::binary);
        if (!input) throw std::runtime_error("Cannot open SCP source: " + path.u8string());
    }
    const auto count = std::min<uint64_t>(capacity, expected - received);
    input.read(reinterpret_cast<char*>(buffer), count);
    if (static_cast<uint64_t>(input.gcount()) != count)
        throw std::runtime_error("SCP source read failed or file was truncated");
    received += count;
    if (received == expected) {
        input.close();
        if (sending.empty()) finished = true;
    }
    return static_cast<int>(count);
}

int ScpFiles::receive(int state, const char* name, word32 size, byte* buffer, word32 count) {
    if (state == WOLFSSH_SCP_NEW_REQUEST) return WS_SCP_CONTINUE;
    if (state == WOLFSSH_SCP_NEW_FILE || state == WOLFSSH_SCP_NEW_DIR) {
        validName(name);
        if (output.is_open() || finished) throw std::runtime_error("Unexpected extra SCP entry");
        fs::path path;
        if (!started) {
            path = fs::is_directory(root) ? root / fs::u8path(name) : root;
            started = true;
        } else {
            if (receiving.empty()) throw std::runtime_error("SCP entry outside destination tree");
            path = receiving.back() / fs::u8path(name);
        }
        destination(path);
        if (state == WOLFSSH_SCP_NEW_DIR) {
            if (receiving.size() >= maxDepth) throw std::runtime_error("SCP directory depth limit (128)");
            if (!fs::create_directory(path) && !fs::is_directory(path))
                throw std::runtime_error("SCP destination is not a directory");
            receiving.push_back(path);
        } else {
            if (fs::exists(path) && !fs::is_regular_file(path))
                throw std::runtime_error("SCP destination is not a regular file");
            output.open(path, std::ios::binary | std::ios::trunc);
            if (!output) throw std::runtime_error("Cannot open SCP destination: " + path.u8string());
            expected = size;
            received = 0;
        }
    } else if (state == WOLFSSH_SCP_FILE_PART) {
        if (!output.is_open() || received + count > expected)
            throw std::runtime_error("Invalid SCP file data length");
        output.write(reinterpret_cast<char*>(buffer), count);
        if (!output) throw std::runtime_error("SCP destination write failed");
        received += count;
    } else if (state == WOLFSSH_SCP_FILE_DONE) {
        if (!output.is_open() || received != expected) throw std::runtime_error("Incomplete SCP file");
        output.close();
        if (!output) throw std::runtime_error("SCP destination close failed");
        if (receiving.empty()) finished = true;
    } else if (state == WOLFSSH_SCP_END_DIR) {
        if (receiving.empty() || output.is_open()) throw std::runtime_error("Invalid SCP directory nesting");
        receiving.pop_back();
        if (receiving.empty()) finished = true;
    } else throw std::runtime_error("Unexpected SCP filesystem operation");
    return WS_SCP_CONTINUE;
}

int ScpFiles::sendCallback(WOLFSSH* ssh, int state, const char*, char* name, word32 nameSize,
        word64* mtime, word64* atime, int* mode, word32, word32* size,
        byte* buffer, word32 capacity, void* context) {
    auto& files = *static_cast<ScpFiles*>(context);
    try {
        if (mtime) *mtime = 0;
        if (atime) *atime = 0;
        return files.send(state, name, nameSize, mode, size, buffer, capacity);
    } catch (const std::exception& error) {
        files.error = error.what();
        wolfSSH_SetScpErrorMsg(ssh, files.error.c_str());
        return WS_SCP_ABORT;
    }
}

int ScpFiles::receiveCallback(WOLFSSH* ssh, int state, const char*, const char* name, int,
        word64, word64, word32 size, byte* buffer, word32 count, word32, void* context) {
    auto& files = *static_cast<ScpFiles*>(context);
    try { return files.receive(state, name, size, buffer, count); }
    catch (const std::exception& error) {
        files.error = error.what();
        wolfSSH_SetScpErrorMsg(ssh, files.error.c_str());
        return WS_SCP_ABORT;
    }
}

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
std::string socketErrorText(int error) {
    if (error == WSAECONNREFUSED) return "Connection refused";
    if (error == WSAECONNRESET) return "Connection reset";
    return "Winsock error " + std::to_string(error);
}
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
    bool passwordAuth = false;
    std::vector<byte> password;
    word32 shellId = 0;
    std::set<word32> confirmed;
    std::vector<byte> outgoing;
    size_t sent = 0;
    std::unique_ptr<ScpFiles> scpFiles;
    std::string scpLocal, scpRemote;
    bool scpUpload = false;
    bool scpDone = false;

    bool flush() {
        while (sent < outgoing.size()) {
#ifdef _WIN32
            const int count = ::send(fd, reinterpret_cast<const char*>(outgoing.data() + sent),
                static_cast<int>(outgoing.size() - sent), 0);
#else
            const int count = ::send(fd, outgoing.data() + sent, outgoing.size() - sent, MSG_NOSIGNAL);
#endif
            if (count < 0) {
                const int error = socketError();
#ifdef _WIN32
                if (error == WSAEWOULDBLOCK) return false;
                if (error == WSAEINTR) continue;
#else
                if (error == EAGAIN || error == EWOULDBLOCK) return false;
                if (error == EINTR) continue;
#endif
                throw std::runtime_error(std::string("Send SSH packet: ") + socketErrorText(error));
            }
            if (count == 0) throw std::runtime_error("SSH socket closed while sending");
            sent += count;
        }
        outgoing.clear();
        sent = 0;
        return true;
    }

    void clearCredentials() {
        volatile byte* secret = password.data();
        for (size_t i = 0; i < password.size(); i++) secret[i] = 0;
        password.clear();
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
        scpFiles.reset();
        clearCredentials();
        outgoing.clear();
    }
    ~Session() { close(); }
};

int authenticate(byte type, WS_UserAuthData* auth, void* context) {
    auto* session = static_cast<Session*>(context);
    if (session->passwordAuth) {
        if (type != WOLFSSH_USERAUTH_PASSWORD) return WOLFSSH_USERAUTH_FAILURE;
        auth->sf.password.password = session->password.data();
        auth->sf.password.passwordSz = session->password.size();
        return WOLFSSH_USERAUTH_SUCCESS;
    }
    if (type != WOLFSSH_USERAUTH_PUBLICKEY) return WOLFSSH_USERAUTH_FAILURE;
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

// These wolfSSH builds consume ChannelRead bytes before sending window updates,
// and discard a new forward channel if sending its open packet would block.
// Accept complete encrypted packets here; flush() handles partial socket writes.
// Application reads/writes wait for this bounded queue to drain.
int sendPacket(WOLFSSH*, void* data, word32 size, void* context) {
    auto& session = *static_cast<Session*>(context);
    try {
        if (session.scpFiles) session.flush();
        if (session.outgoing.size() + size > 256 * 1024)
            return session.scpFiles ? WS_CBIO_ERR_WANT_WRITE : WS_CBIO_ERR_GENERAL;
        const auto* bytes = static_cast<byte*>(data);
        session.outgoing.insert(session.outgoing.end(), bytes, bytes + size);
        return static_cast<int>(size);
    } catch (...) { return WS_CBIO_ERR_GENERAL; }
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
napi_value property(napi_env env, napi_value object, const char* name) {
    napi_value value;
    check(NAPI(napi_get_named_property)(env, object, name, &value));
    return value;
}
Session* sessionArgument(napi_env env, napi_value value) {
    void* data = nullptr;
    check(NAPI(napi_get_value_external)(env, value, &data));
    return static_cast<Session*>(data);
}
std::vector<napi_value> arguments(napi_env env, napi_callback_info info, size_t count, size_t optional = 0) {
    std::vector<napi_value> values(count);
    size_t actual = count;
    check(NAPI(napi_get_cb_info)(env, info, &actual, values.data(), nullptr, nullptr));
    if (actual < count - optional) throw std::runtime_error("Wrong native addon argument count");
    values.resize(actual);
    return values;
}
int errorCode(Session& session, int result) {
    return result == WS_ERROR || result == WS_FATAL_ERROR ? wolfSSH_get_error(session.ssh) : result;
}
bool retry(Session& session, int result) {
    const int error = errorCode(session, result);
    // wolfSSH collapses recv's connection reset into a generic socket error.
    // Preserve it before another socket operation so Transport can retry warmup.
    const int networkError = socketError();
#ifdef _WIN32
    const bool reset = networkError == WSAECONNRESET;
#else
    const bool reset = networkError == ECONNRESET;
#endif
    if (error == WS_SOCKET_ERROR_E && reset)
        throw std::runtime_error(std::string("SSH socket: ") + socketErrorText(networkError));
    if (error == WS_WANT_READ || error == WS_WANT_WRITE || error == WS_REKEYING ||
        error == WS_WINDOW_FULL || error == WS_CHANNEL_NOT_CONF)
        return true;
    requireSuccess(error, "wolfSSH I/O");
    return false;
}

napi_value create(napi_env env, napi_callback_info info) {
    try {
        const auto config = arguments(env, info, 1)[0];
        const auto host = stringArgument(env, property(env, config, "host"));
        int32_t port;
        check(NAPI(napi_get_value_int32)(env, property(env, config, "port"), &port));
        const auto username = stringArgument(env, property(env, config, "username"));
        bool terminal;
        check(NAPI(napi_get_value_bool)(env, property(env, config, "terminal"), &terminal));
        const auto auth = property(env, config, "auth");
        const auto authType = stringArgument(env, property(env, auth, "type"));
        void* secret;
        size_t size;
        auto session = std::make_unique<Session>();
        if (authType == "password") {
            check(NAPI(napi_get_buffer_info)(env, property(env, auth, "password"), &secret, &size));
            session->passwordAuth = true;
            session->password.assign(static_cast<byte*>(secret), static_cast<byte*>(secret) + size);
        } else if (authType == "x509") {
            check(NAPI(napi_get_buffer_info)(env, property(env, auth, "identity"), &secret, &size));
            loadIdentity(*session, static_cast<byte*>(secret), size);
        } else throw std::runtime_error("Unsupported SSH authentication type");
        session->ctx = wolfSSH_CTX_new(WOLFSSH_ENDPOINT_CLIENT, nullptr);
        if (!session->ctx) throw std::runtime_error("Cannot allocate wolfSSH context");
        wolfSSH_SetUserAuth(session->ctx, authenticate);
        wolfSSH_SetIOSend(session->ctx, sendPacket);
        // The API supplies no server trust material. This does not verify host identity.
        wolfSSH_CTX_SetPublicKeyCheck(session->ctx, [](const byte*, word32, void*) -> int {
            return WS_SUCCESS;
        });
        requireSuccess(wolfSSH_CTX_SetChannelOpenRespCb(session->ctx,
            [](WOLFSSH_CHANNEL* channel, void* context) -> int {
                word32 id;
                const int status = wolfSSH_ChannelGetId(channel, &id, WS_CHANNEL_ID_SELF);
                if (status == WS_SUCCESS) static_cast<Session*>(context)->confirmed.insert(id);
                return status;
            }, nullptr), "Set channel confirmation callback");
        session->ssh = wolfSSH_new(session->ctx);
        if (!session->ssh) throw std::runtime_error("Cannot allocate wolfSSH session");
        wolfSSH_SetUserAuthCtx(session->ssh, session.get());
        requireSuccess(wolfSSH_SetChannelOpenCtx(session->ssh, session.get()), "Set channel context");
        requireSuccess(wolfSSH_SetUsername(session->ssh, username.c_str()), "Set username");
        if (terminal)
            requireSuccess(wolfSSH_SetChannelType(session->ssh, WOLFSSH_SESSION_TERMINAL, nullptr, 0), "Request terminal");
        // This list covers server host keys as well as X.509 client authentication.
        requireSuccess(wolfSSH_SetAlgoListKey(session->ssh,
            "x509v3-ecdsa-sha2-nistp256,x509v3-ecdsa-sha2-nistp384,x509v3-ecdsa-sha2-nistp521,"
            "x509v3-ssh-rsa,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,"
            "ssh-ed25519,rsa-sha2-256,rsa-sha2-512,ssh-rsa"), "Set key algorithms");
        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        addrinfo* addresses = nullptr;
        const int status = getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &addresses);
        if (status != 0) throw std::runtime_error(std::string("Resolve SSH host: ") + gai_strerror(status));
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
        if (session->fd == invalidSocket) throw std::runtime_error(std::string("Connect SSH: ") + socketErrorText(lastError));
        requireSuccess(wolfSSH_set_fd(session->ssh, session->fd), "Attach SSH socket");
        wolfSSH_SetIOWriteCtx(session->ssh, session.get());
        napi_value result;
        check(NAPI(napi_create_external)(env, session.get(), [](napi_env, void* data, void*) {
            delete static_cast<Session*>(data);
        }, nullptr, &result));
        session.release();
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

void connectSocket(Session& session) {
    if (!session.connected) {
#ifdef _WIN32
        fd_set writable;
        FD_ZERO(&writable);
        FD_SET(session.fd, &writable);
        fd_set failed = writable;
        timeval instant{0, 0};
        const int status = select(0, nullptr, &writable, &failed, &instant);
        if (status == SOCKET_ERROR) throw std::runtime_error("Cannot select SSH socket");
#else
        pollfd descriptor{session.fd, POLLOUT, 0};
        const int status = poll(&descriptor, 1, 0);
        if (status < 0 && errno != EINTR) throw std::runtime_error("Cannot poll SSH socket");
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
            if (error) throw std::runtime_error(std::string("Connect SSH: ") + socketErrorText(error));
            session.connected = true;
        }
    }
}

napi_value handshake(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 1);
        auto& session = *sessionArgument(env, args[0]);
        if (session.fd == invalidSocket) throw std::runtime_error("Native session is closed");
        connectSocket(session);
        if (session.connected && !session.ready) {
            session.flush();
            const int status = wolfSSH_connect(session.ssh);
            if (status != WS_SUCCESS) retry(session, status);
            session.flush();
            if (status == WS_SUCCESS) {
                session.ready = true;
                requireSuccess(wolfSSH_ChannelGetId(wolfSSH_ChannelNext(session.ssh, nullptr),
                    &session.shellId, WS_CHANNEL_ID_SELF), "Get shell channel");
                session.clearCredentials();
            }
        }
        napi_value result;
        check(NAPI(napi_get_boolean)(env, session.ready, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value poll(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 2);
        auto& session = *sessionArgument(env, args[0]);
        bool receive;
        check(NAPI(napi_get_value_bool)(env, args[1], &receive));
        if (!session.ssh) throw std::runtime_error("Native session is closed");
        session.flush();
        const int status = receive ? wolfSSH_worker(session.ssh, nullptr) : WS_WANT_READ;
        if (status != WS_SUCCESS && status != WS_CHAN_RXD && status != WS_EXTDATA && status != WS_CHANNEL_CLOSED)
            retry(session, status);
        session.flush();
        napi_value result;
        check(NAPI(napi_get_boolean)(env, status == WS_SUCCESS || status == WS_CHAN_RXD ||
            status == WS_EXTDATA || status == WS_CHANNEL_CLOSED, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value scpStep(napi_env env, napi_callback_info info) {
    Session* active = nullptr;
    try {
        const auto args = arguments(env, info, 4);
        auto& session = *sessionArgument(env, args[0]);
        active = &session;
        if (!session.ssh) throw std::runtime_error("Native session is closed");
        if (!session.scpFiles) {
            if (session.ready) throw std::runtime_error("SCP requires a fresh SSH session");
            check(NAPI(napi_get_value_bool)(env, args[1], &session.scpUpload));
            session.scpLocal = stringArgument(env, args[2]);
            session.scpRemote = stringArgument(env, args[3]);
            session.scpFiles = std::make_unique<ScpFiles>(session.scpLocal, session.scpUpload);
            session.scpFiles->attach(session.ctx, session.ssh);
            // Recursive download also accepts a single file. Upload callbacks
            // choose file/directory lazily without scanning the source tree.
            requireSuccess(wolfSSH_SetScpRecursive(session.ssh, 1), "Enable recursive SCP");
        }
        connectSocket(session);
        if (session.connected && session.flush() && !session.scpDone) {
            const int status = session.scpUpload
                ? wolfSSH_SCP_to(session.ssh, session.scpLocal.c_str(), session.scpRemote.c_str())
                : wolfSSH_SCP_from(session.ssh, session.scpRemote.c_str(), session.scpLocal.c_str());
            if (!session.scpFiles->error.empty()) throw std::runtime_error(session.scpFiles->error);
            if (status == WS_SUCCESS) {
                if (!session.scpFiles->complete())
                    throw std::runtime_error("Incomplete SCP transfer or remote scp failed");
                session.scpDone = true;
            } else {
                if (errorCode(session, status) == WS_EXTDATA) {
                    byte message[1024];
                    const int size = wolfSSH_extended_data_read(session.ssh, message, sizeof(message) - 1);
                    if (size > 0) {
                        message[size] = 0;
                        wolfSSH_SetScpErrorMsg(session.ssh, reinterpret_cast<char*>(message));
                    }
                } else retry(session, status);
            }
        }
        const bool done = session.scpDone && session.flush();
        napi_value result;
        check(NAPI(napi_get_boolean)(env, done, &result));
        return result;
    } catch (const std::exception& error) {
        std::string message = error.what();
        if (active && active->ssh && active->scpFiles && active->scpFiles->error.empty()) {
            if (const char* remote = wolfSSH_GetScpErrorMsg(active->ssh)) message = std::string("Remote SCP: ") + remote;
        }
        while (!message.empty() && (message.back() == '\n' || message.back() == '\r')) message.pop_back();
        NAPI(napi_throw_error)(env, nullptr, message.c_str());
        return nullptr;
    }
}

napi_value openForward(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 3);
        auto& session = *sessionArgument(env, args[0]);
        if (!session.ssh || !session.ready) throw std::runtime_error("SSH session is not ready");
        const auto host = stringArgument(env, args[1]);
        uint32_t port;
        check(NAPI(napi_get_value_uint32)(env, args[2], &port));
        auto* channel = wolfSSH_ChannelFwdNewLocal(session.ssh, host.c_str(), port, "127.0.0.1", 0);
        // A failed creation can have already queued an open packet in wolfSSH.
        // Do not create another channel on that connection; let the owner close it.
        if (!channel) throw std::runtime_error(std::string("Open SSH forwarding channel: ") +
            wolfSSH_get_error_name(session.ssh));
        word32 id;
        requireSuccess(wolfSSH_ChannelGetId(channel, &id, WS_CHANNEL_ID_SELF), "Get forwarding channel");
        napi_value result;
        check(NAPI(napi_create_uint32)(env, id, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value forwardReady(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 2);
        auto& session = *sessionArgument(env, args[0]);
        uint32_t id;
        check(NAPI(napi_get_value_uint32)(env, args[1], &id));
        if (!session.ssh || !wolfSSH_ChannelFind(session.ssh, id, WS_CHANNEL_ID_SELF))
            throw std::runtime_error("SSH forwarding channel was rejected or closed");
        napi_value result;
        check(NAPI(napi_get_boolean)(env, session.confirmed.count(id) != 0, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

WOLFSSH_CHANNEL* channelArgument(napi_env env, Session& session, napi_value value) {
    uint32_t id;
    check(NAPI(napi_get_value_uint32)(env, value, &id));
    return wolfSSH_ChannelFind(session.ssh, id, WS_CHANNEL_ID_SELF);
}

napi_value read(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 2, 1);
        auto& session = *sessionArgument(env, args[0]);
        if (!session.ssh) throw std::runtime_error("Native session is closed");
        byte data[32768];
        const bool forward = args.size() == 2;
        auto* channel = forward ? channelArgument(env, session, args[1]) :
            wolfSSH_ChannelFind(session.ssh, session.shellId, WS_CHANNEL_ID_SELF);
        int count = 0;
        const bool flushed = session.flush();
        if (channel && flushed) {
            if (forward) count = wolfSSH_ChannelRead(channel, data, sizeof(data));
            else {
                count = wolfSSH_extended_data_read(session.ssh, data, sizeof(data));
                if (count == 0) {
                    // Only read buffered shell data. stream_read's internal receive
                    // loop must not consume a forward channel or a removed shell.
                    count = wolfSSH_stream_peek(session.ssh, nullptr, sizeof(data));
                    if (count > 0) count = wolfSSH_stream_read(session.ssh, data, count);
                }
            }
        }
        if (!channel || (flushed && count == 0 && wolfSSH_ChannelGetEof(channel)) ||
            (count < 0 && errorCode(session, count) == WS_EOF)) {
            napi_value result;
            check(NAPI(napi_get_null)(env, &result));
            return result;
        }
        if (count < 0) { retry(session, count); count = 0; }
        napi_value result;
        check(NAPI(napi_create_buffer_copy)(env, count, data, nullptr, &result));
        return result;
    } catch (const std::exception& error) { NAPI(napi_throw_error)(env, nullptr, error.what()); return nullptr; }
}

napi_value write(napi_env env, napi_callback_info info) {
    try {
        const auto args = arguments(env, info, 3, 1);
        auto& session = *sessionArgument(env, args[0]);
        if (!session.ssh) throw std::runtime_error("Native session is closed");
        void* data;
        size_t size;
        check(NAPI(napi_get_buffer_info)(env, args[1], &data, &size));
        const bool forward = args.size() == 3;
        auto* channel = forward ? channelArgument(env, session, args[2]) :
            wolfSSH_ChannelFind(session.ssh, session.shellId, WS_CHANNEL_ID_SELF);
        if (!channel) throw std::runtime_error("SSH channel is closed");
        const word32 length = size > 32768 ? 32768 : size;
        int count = 0;
        if (session.flush()) {
            count = forward ? wolfSSH_ChannelSend(channel, static_cast<byte*>(data), length) :
                wolfSSH_stream_send(session.ssh, static_cast<byte*>(data), length);
            session.flush();
        }
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
            {"scpStep", nullptr, scpStep, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"poll", nullptr, poll, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"openForward", nullptr, openForward, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"forwardReady", nullptr, forwardReady, nullptr, nullptr, nullptr, napi_default, nullptr},
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

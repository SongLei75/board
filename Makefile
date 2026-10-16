# @carizon/board-session 构建 + 发布 (推送到 jfrog)
#
# 用法:
#   make build                        # 编译原生 addon + TypeScript -> prebuilds/ + dist/
#   make pack                         # 只打包 tarball (依赖 build-ts), 产物在系统临时目录, 不入库
#   make publish                      # 打包 -> 推送 jfrog vscode (同版本先删后推), 认证 = 交互输入
#                                      # 改了 native/addon.cc 需先 make build 刷新 prebuilds/, 再 pack/publish
#   make publish dry=1                # 只打包并打印清单, 不推送 (等价 --dry-run)
#   make publish version=0.1.0-carizon.1   # 指定推送版本 (缺省 0.1.0-carizon)
#   make publish tag=xx               # 指定 dist-tag 推送
#   make clean                        # 删除 dist/ 与打好的 tarball
#
# 发布版本号只在打包时写进 tarball 内的 package.json, 不动仓库文件 (沿用
# foundry-local 的 -carizon 约定)。推送协议与 npm 12 libnpmpublish 一致,
# 认证 = 交互输入账号密码 (Basic 头随请求发送, 不落盘)。打包全程在系统临时目录
# 完成, 仓库不留产物。

version ?= 0.1.0-carizon
registry ?= https://jfrog.carizon.work/artifactory/api/npm/vscode/
tag ?= carizon
# dry=1 -> --dry-run (只打包打印, 不推送)
dry ?=

.DEFAULT_GOAL := publish
.PHONY: build build-native build-ts pack publish clean

# 全量构建: 原生 addon + TypeScript (改 native/addon.cc 后显式运行, 刷新 prebuilds/)
build: build-native build-ts

# 原生 addon: cmake 编译 native/addon.cc -> prebuilds/<plat>-<arch>/ (脚本自带环境探测)
# 需要 build/ 下的 wolfSSH/wolfSSL 安装树 (或 WOLFSSH_ROOT/WOLFSSL_ROOT); build/ 不入库。
build-native:
	node scripts/build-native.mjs

# TypeScript -> dist/ (每次打包前确保 dist 不缺失/不过期)
build-ts:
	npm run build:ts

# 只打包, 不推送; tarball 在 publish.py 的临时目录里, 这里仅做清单核对。
# 只依赖 build-ts: prebuilds/ 是入库的预构建产物 (foundry-local 同款模型), 打包不重建原生。
pack: build-ts
	python3 publish.py npm --version $(version) --registry $(registry) --tag $(tag) --dry-run

# 打包 -> 打印打包来源/推送目标 -> 认证 -> 查整包 (404 = 不存在) ->
# DELETE -rev 删旧版本 -> PUT metadata+_attachments。任何失败直接退出, 不降级。
publish: build-ts
	python3 publish.py npm --version $(version) --registry $(registry) --tag $(tag) $(if $(dry),--dry-run,)

clean:
	rm -rf dist
	rm -f @carizon-board-session-*.tgz carizon-board-session-*.tgz

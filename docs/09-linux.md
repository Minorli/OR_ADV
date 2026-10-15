# 无显示器 Linux 开发机

## 第一次环境检查

    python3 scripts/verify_bundle.py
    bash scripts/doctor.sh
    python3 scripts/validate_package.py

脚本不联网、不读取云凭据、不修改系统。缺失工具时根据系统发行版，从官方渠道准备 Git、Python 3、受维护的 Node.js 和 npm；不要复制不明来源一键 root 脚本。Node 本地开发版本与云函数运行时是两回事。建议优先核对 Node 24 LTS 的工具兼容性；若依赖明确需要 Node 22，记录支持期限，不继续使用已停止维护的 Node 20 作为新项目默认。

## 安装前核对版本

下列命令会联网读取 npm 元数据，需机器具备网络：

    node --version
    npm --version
    npm view @cloudbase/cli version engines
    npm view miniprogram-ci version engines

选择受支持的确切版本，先在用户级环境安装 CLI 和本地项目依赖，保留 lockfile。不要仅因包能安装就认定兼容，需跑登录、预览及真实上传。不要直接将老示例的云函数 Node 16 运行时作为生产默认。

    npm install --global @cloudbase/cli
    npm install --save-dev --save-exact miniprogram-ci
    tcb --version
    tcb --help

上面的首次安装命令会解析当时版本，安装后记录实际版本；正式流水线通过 lockfile/npm ci 固定，CLI 也固定到已验证版本。没有全局写权限时使用 Node 用户目录或团队已有工具管理方式，不为此随意 sudo 安装。

## 云端设备码登录

    TCB_NO_BROWSER=true tcb login
    tcb env list

终端给出网址和验证码，在另一台电脑打开，使用被公司授权的身份确认。若身份只拥有部分资源，核对 CLI 操作需要的实际权限。登录会话存在本地 CLI 凭据目录，保护该目录，不打包上传 Git。需要长期 CI 身份时单独设计范围和轮换，不把个人长期主账号密钥塞进仓库。

若登录成功却看不到环境，先查账号与授权、地域/环境，不新建相似名字“试一试”。若使用旧 CLI 没有设备码行为，核对版本与官方安装说明，不假设是服务器没显示器。

## 微信代码上传

不需要 Linux 登录桌面微信。管理员生成本小程序的上传私钥，并设置实际上传进程的公网出口 IP 白名单。不要把 192.168/10.x 私网地址填写成公网出口；代理、NAT 与固定出口变化需要同步核对。

私钥放源码目录外的受限目录，文件权限建议仅执行用户可读。config/local.json 只记录路径，不记录私钥正文。

    cp config/local.example.json config/local.json
    node scripts/wechat-ci.cjs preview --env test --config config/local.json

默认 dry-run，检查项不足会明确失败。未来原生 app 和构建元数据齐备后，才可加 --execute 真正预览/上传；详见微信章节。命令执行者不得把私钥正文粘贴到终端命令或 AI 消息。

## 本地电脑与手机

在 Mac/Windows 的微信开发者工具打开同一 Git 提交和原生项目，登录开发者自己的微信，核对 AppID、库版本和环境。Linux CI 预览可生成二维码，但不能替代本地调试器、真实微信隐私流程、系统权限、弱网和不同手机验收。

如果只有 Linux，仍可编码和上传；正式验收需安排能运行官方工具的电脑和 iOS/Android 手机，不购买不明来源“Linux 微信开发者工具”来绕过官方能力。

## 每天的工作闭环

拉取私有仓库 → 查看 HANDOFF → 本地实现/测试 → 测试云部署 → 预览码/体验版 → 手机上验证 → 提交源代码与脱敏记录。开发机重启、换代理、换 Node 或更换云授权后，只复查受到影响的环节。

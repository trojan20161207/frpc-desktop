import {app, ipcMain, Notification} from "electron";
import {Config, getConfig} from "../storage/config";
import {listProxy, Proxy} from "../storage/proxy";
import {getVersionById} from "../storage/version";
import treeKill from "tree-kill";

const fs = require("fs");
const path = require("path");
const {exec, spawn} = require("child_process");
export let frpcProcess = null;
const runningCmd = {
    commandPath: null,
    configPath: null
};
let frpcStatusListener = null;

/**
 * 获取选择版本的工作目录
 * @param versionId 版本ID
 * @param callback
 */
const getFrpcVersionWorkerPath = (
    versionId: string,
    callback: (workerPath: string) => void
) => {
    getVersionById(versionId, (err2, version) => {
        if (!err2) {
            if (version) {
                callback(version["frpcVersionPath"]);
            }
        }
    });
};

/**
 * 生成toml配置文件
 * @param config
 * @param proxys
 */
const genTomlConfig = (config: Config, proxys: Proxy[]) => {
    const proxyToml = proxys.map(m => {
        let toml = `
[[proxies]]
name = "${m.name}"
type = "${m.type}"
localIP = "${m.localIp}"
localPort = ${m.localPort}
`;
        switch (m.type) {
            case "tcp":
                toml += `remotePort = ${m.remotePort}`;
                break;
            case "http":
            case "https":
                toml += `customDomains=[${m.customDomains.map(m => `"${m}"`)}]`;
                break;
            default:
                break;
        }

        return toml;
    });
    const toml = `
serverAddr = "${config.serverAddr}"
serverPort = ${config.serverPort}
auth.method = "${config.authMethod}"
auth.token = "${config.authToken}"
log.to = "frpc.log"
log.level = "${config.logLevel}"
log.maxDays = ${config.logMaxDays}
webServer.addr = "127.0.0.1"
webServer.port = 57400
transport.tls.enable = ${config.tlsConfigEnable}
${config.tlsConfigEnable ? `
transport.tls.certFile = "${config.tlsConfigCertFile}"
transport.tls.keyFile = "${config.tlsConfigKeyFile}"
transport.tls.trustedCaFile = "${config.tlsConfigTrustedCaFile}"
transport.tls.serverName = "${config.tlsConfigServerName}"
` : ""}
${config.proxyConfigEnable ? `
transport.proxyURL = "${config.proxyConfigProxyUrl}"
` : ""}

${proxyToml.join("")}
      `;
    return toml;
}


/**
 * 生成ini配置
 * @param config
 * @param proxys
 */
const genIniConfig = (config: Config, proxys: Proxy[]) => {
    const proxyIni = proxys.map(m => {
        let ini = `
[${m.name}]
type = "${m.type}"
local_ip = "${m.localIp}"
local_port = ${m.localPort}
`;
        switch (m.type) {
            case "tcp":
                ini += `remote_port = ${m.remotePort}`;
                break;
            case "http":
            case "https":
                ini += `custom_domains=[${m.customDomains.map(m => `"${m}"`)}]`;
                break;
            default:
                break;
        }

        return ini;
    });
    const ini = `
[common]
server_addr = ${config.serverAddr}
server_port = ${config.serverPort}
authentication_method = "${config.authMethod}"
auth_token = "${config.authToken}"
log_file = "frpc.log"
log_level = ${config.logLevel}
log_max_days = ${config.logMaxDays}
admin_addr = 127.0.0.1
admin_port = 57400
tls_enable = ${config.tlsConfigEnable}
${config.tlsConfigEnable ? `
tls_cert_file = ${config.tlsConfigCertFile}
tls_key_file = ${config.tlsConfigKeyFile}
tls_trusted_ca_file = ${config.tlsConfigTrustedCaFile}
tls_server_name = ${config.tlsConfigServerName}
` : ""}
${config.proxyConfigEnable ? `
http_proxy = "${config.proxyConfigProxyUrl}"
` : ""}

${proxyIni.join("")}
    `
    return ini;
}

/**
 * 生成配置文件
 */
export const generateConfig = (
    config: Config,
    callback: (configPath: string) => void
) => {
    listProxy((err3, proxys) => {
        if (!err3) {
            console.log(config, 'config')
            const {currentVersion} = config;
            let filename = null;
            let configContent = "";
            if (currentVersion < 124395282) {
                // 版本小于v0.52.0
                filename = "frp.ini";
                configContent = genIniConfig(config, proxys)
            } else {
                filename = "frp.toml";
                configContent = genTomlConfig(config, proxys)
            }
            const configPath = path.join(app.getPath("userData"), filename)
            console.debug("生成配置成功", configPath)
            fs.writeFile(
                configPath, // 配置文件目录
                configContent, // 配置文件内容
                {flag: "w"},
                err => {
                    if (!err) {
                        callback(filename);
                    }
                }
            );
        }
    });
};

/**
 * 启动frpc子进程
 * @param cwd
 * @param commandPath
 * @param configPath
 */
const startFrpcProcess = (commandPath: string, configPath: string) => {
    console.log(commandPath, 'commandP')
    const command = `${commandPath} -c ${configPath}`;
    console.info("启动", command)
    frpcProcess = spawn(command, {
        cwd: app.getPath("userData"),
        shell: true
    });
    runningCmd.commandPath = commandPath;
    runningCmd.configPath = configPath;
    frpcProcess.stdout.on("data", data => {
        console.debug(`命令输出: ${data}`);
    });
    frpcProcess.stdout.on("error", data => {
        console.log("启动错误", data)
        stopFrpcProcess(() => {
        })
    });
    frpcStatusListener = setInterval(() => {
        const status = frpcProcessStatus()
        if (!status) {
            console.log("连接已断开")
            new Notification({
                title: "Frpc Desktop",
                body: "连接已断开，请前往日志查看原因"
            }).show()
            clearInterval(frpcStatusListener)
        }
    }, 3000)
};

/**
 *  重载frpc配置
 */
export const reloadFrpcProcess = () => {
    if (frpcProcess && !frpcProcess.killed) {
        getConfig((err1, config) => {
            if (!err1) {
                if (config) {
                    generateConfig(config, configPath => {
                        const command = `${runningCmd.commandPath} reload -c ${configPath}`;
                        console.info("重启", command);
                        exec(command, {
                            cwd: app.getPath("userData"),
                            shell: true
                        });
                    });
                }
            }
        });
    }
};

/**
 * 停止frpc子进程
 */
export const stopFrpcProcess = (callback?: () => void) => {
    if (frpcProcess) {
        treeKill(frpcProcess.pid, (error: Error) => {
            if (error) {
                console.log("关闭失败", frpcProcess.pid, error)
            } else {
                console.log('关闭成功')
                frpcProcess = null
                clearInterval(frpcStatusListener)
            }
            callback()
        })
    }
}

/**
 * 获取frpc子进程状态
 */
export const frpcProcessStatus = () => {
    if (!frpcProcess) {
        return false;
    }
    try {
        // 发送信号给进程，如果进程存在，会正常返回
        process.kill(frpcProcess.pid, 0);
        return true;
    } catch (error) {
        // 进程不存在，抛出异常
        return false;
    }
}

/**
 * 启动frpc流程
 * @param config
 */
export const startFrpWorkerProcess = (config: Config) => {
    getFrpcVersionWorkerPath(
        config.currentVersion,
        (frpcVersionPath: string) => {
            console.log(1, '1')
            if (frpcVersionPath) {
                generateConfig(config, configPath => {
                    const platform = process.platform;
                    if (platform === 'win32') {
                        startFrpcProcess(
                            path.join(frpcVersionPath, "frpc.exe"),
                            configPath
                        );
                    } else {
                        startFrpcProcess(
                            path.join(frpcVersionPath, "frpc"),
                            configPath
                        );
                    }
                });
            }
        }
    );
}


export const initFrpcApi = () => {
    ipcMain.handle("frpc.running", async (event, args) => {
        return frpcProcessStatus()
    });

    ipcMain.on("frpc.start", async (event, args) => {
        getConfig((err1, config) => {
            if (!err1) {
                if (config) {
                    startFrpWorkerProcess(config)
                } else {
                    event.reply(
                        "Home.frpc.start.error.hook", "请先前往设置页面，修改配置后再启动"
                    );
                }
            }
        });

    });

    ipcMain.on("frpc.stop", () => {
        if (frpcProcess && !frpcProcess.killed) {
            stopFrpcProcess(() => {
            })
        }
    });
};

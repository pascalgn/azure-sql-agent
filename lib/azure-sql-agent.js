#!/usr/bin/env node

const os = require('os');
const fs = require('fs-extra');
const process = require('process');
const child_process = require('child_process');

const Notify = require('fs.notify');
const ip = require('ip');
const Promise = require('promise');
const spawn = require('child-process-promise').spawn;
const defaultGateway = require('default-gateway');
const internalIp = require('internal-ip');
const publicIp = require('public-ip');
const notifier = require('node-notifier');

const internalCheckWait = 1000;
const publicCheckWait = 5 * 60 * 1000;

const defaultConfig = {
    'prefix': 'my-prefix',
    'notifications': false,
    'servers': [
        {
            'subscription': 'hex-subscription-id',
            'resourceGroup': 'resource-group-name',
            'name': 'server-name'
        }
    ]
};

const home = `${os.homedir()}/.azure-sql-agent`;
const configFile = `${home}/config.json`;
const pidFile = `${home}/agent.pid`;

function readConfig() {
    return fs.readJson(configFile)
        .catch(err => {
            if (err.code === 'ENOENT') {
                return fs.ensureDir(home)
                    .then(() => fs.writeJson(configFile, defaultConfig, { 'spaces': 2 }))
                    .then(() => console.log(`Default configuration written: ${configFile}`))
                    .then(() => defaultConfig);
            } else {
                throw err;
            }
        });
}

function az(args) {
    return Promise.resolve()
        .then(() => console.log(` -> az ${args.slice(0, args.findIndex(arg => arg.startsWith('-'))).join(' ')}`))
        .then(() => spawn('az', args, { 'capture': ['stdout', 'stderr'] }))
        .then(result => (result.stdout ? JSON.parse(result.stdout) : {}))
        .catch(err => {
            throw new Error(err.stderr || err);
        });
}

function setFirewallRules(ipAddress) {
    return readConfig()
        .then(config => {
            const servers = config.servers || [];
            const result = {};
            return forEachPromise(servers, server => setFirewallRule(config, server, ipAddress, result))
                .then(() => maybeShowNotification(config, result, ipAddress));
        });
}

function setFirewallRule(config, server, ipAddress, result) {
    const configPrefix = server.prefix || config.prefix;
    if (!configPrefix) {
        throw new Error('No prefix configured!');
    }
    const prefix = `${configPrefix}-`;
    return az(['account', 'set', '--subscription', server.subscription])
        .then(() => az(['sql', 'server', 'firewall-rule', 'list', '-g', server.resourceGroup, '-s', server.name]))
        .then(rules => {
            let exists = false;
            const oldRules = [];
            for (const rule of rules) {
                if (rule.name.startsWith(prefix)) {
                    if (rule.startIpAddress === ipAddress && rule.endIpAddress === ipAddress) {
                        exists = true;
                    } else {
                        oldRules.push(rule);
                    }
                }
            }
            const removeRules = forEachPromise(oldRules, rule => az(['sql', 'server', 'firewall-rule', 'delete',
                '-g', server.resourceGroup, '-s', server.name, '-n', rule.name]));
            if (exists) {
                return removeRules;
            } else {
                const ruleName = `${prefix}${ip.toLong(ipAddress)}`;
                return removeRules
                    .then(() => az(['sql', 'server', 'firewall-rule', 'create',
                        '-g', server.resourceGroup, '-s', server.name, '-n', ruleName,
                        '--start-ip-address', ipAddress, '--end-ip-address', ipAddress]))
                    .then(() => {
                        if (result.rulesCreated) {
                            result.rulesCreated += 1;
                        } else {
                            result.rulesCreated = 1;
                        }
                    });
            }
        })
        .then(() => console.log(`Server configured: ${server.name}`));
}

function maybeShowNotification(config, result, ipAddress) {
    if (config.notifications && result.rulesCreated) {
        notifier.notify({
            title: 'Azure SQL Agent',
            message: `Firewall rules have been successfully updated for your public IP address ${ipAddress}`
        });
    }
}

function forEachPromise(items, fn) {
    return items.reduce((promise, item) => promise.then(() => fn(item)), Promise.resolve());
}

function internalIpChanged(ctx) {
    return internalIp.v4()
        .then(ipAddress => defaultGateway.v4()
            .then(result => {
                let changed = false;
                if (ctx.internalIp !== ipAddress) {
                    ctx.internalIp = ipAddress;
                    changed = true;
                }
                if (ctx.gateway !== result.gateway || ctx.interface !== result.interface) {
                    ctx.gateway = result.gateway;
                    ctx.interface = result.interface;
                    changed = true;
                }
                return changed;
            }))
        .catch(() => {
            ctx.internalIp = null;
            ctx.gateway = null;
            ctx.interface = null;
            return false;
        });
}

function publicIpChanged(ctx) {
    return publicIp.v4()
        .then(ipAddress => {
            if (ctx.publicIp !== ipAddress) {
                ctx.publicIp = ipAddress;
                return true;
            } else {
                return false;
            }
        })
        .catch(() => {
            ctx.publicIp = null;
            return false;
        });
}

function main() {
    const pid = fork();
    if (pid) {
        console.log(`Agent is running now: ${pid}`);
        return writePid(pid);
    } else {
        return runAgent();
    }
}

function fork() {
    if (process.env.__daemon) {
        // we are the child
        return 0;
    }
    const args = process.argv.slice(1);
    const opts = {
        'detached': true,
        'windowsHide': true,
        'stdio': 'ignore'
    };
    process.env.__daemon = true;
    const child = child_process.spawn(process.execPath, args, opts);
    child.unref();
    return child.pid;
}

function writePid(pid) {
    return fs.ensureDir(home)
        .then(() => fs.writeFile(pidFile, `${pid}`));
}

function runAgent() {
    const ctx = {
        'nextPublicCheck': Date.now() + publicCheckWait
    };
    return Promise.resolve()
        // make sure config file exists:
        .then(() => readConfig())
        .then(() => watchConfigFile(ctx))
        .then(() => mainLoop(ctx))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

function watchConfigFile(ctx) {
    new Notify([configFile]).on('change', () => {
        ctx.forceSetRules = true;
    });
}

function mainLoop(ctx = {}) {
    return Promise.resolve()
        .then(() => {
            if (ctx.forceSetRules) {
                if (ctx.publicIp) {
                    ctx.forceSetRules = false;
                    return true;
                } else {
                    // if this fails, we'll try again in the next loop
                    return publicIpChanged(ctx);
                }
            } else {
                return internalIpChanged(ctx)
                    .then(intChange => {
                        let checkPublic = false;
                        if (intChange) {
                            checkPublic = true;
                        } else if (!ctx.nextPublicCheck || ctx.nextPublicCheck > Date.now()) {
                            checkPublic = true;
                        }
                        if (checkPublic) {
                            ctx.nextPublicCheck = Date.now() + publicCheckWait;
                            return publicIpChanged(ctx);
                        } else {
                            return false;
                        }
                    });
            }
        })
        .then(setRules => {
            if (setRules) {
                const ipAddress = ctx.publicIp;
                if (ipAddress) {
                    return setFirewallRules(ipAddress);
                }
            }
        })
        .then(() => new Promise(resolve => setTimeout(resolve, internalCheckWait)))
        .then(() => mainLoop(ctx));
}

main();
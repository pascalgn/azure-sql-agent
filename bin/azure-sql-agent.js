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
const winston = require('winston');

require('pkginfo')(module);

const internalCheckWait = 1000;
const publicCheckWait = 5 * 60 * 1000;
const errorSleep = 3000;

const defaultConfig = {
    'prefix': 'my-prefix',
    'notifications': false,
    'errorNotifications': true,
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

const logger = new winston.Logger({
    level: 'info',
    transports: [
        new winston.transports.File({
            filename: `${home}/agent.log`,
            json: false,
            maxsize: 100 * 1024,
            maxFiles: 3,
            tailable: true
        })
    ]
});

function readConfig() {
    return fs.readJson(configFile)
        .catch(err => {
            if (err.code === 'ENOENT') {
                return fs.ensureDir(home)
                    .then(() => fs.writeJson(configFile, defaultConfig, { 'spaces': 2 }))
                    .then(() => logger.info(`Default configuration written: ${configFile}`))
                    .then(() => defaultConfig);
            } else {
                throw err;
            }
        });
}

function az(args, retries = 2) {
    return Promise.resolve()
        .then(() => logger.debug(` -> az ${args.slice(0, args.findIndex(arg => arg.startsWith('-'))).join(' ')}`))
        .then(() => spawn('az', args, { 'capture': ['stdout', 'stderr'] }))
        .then(result => (result.stdout ? JSON.parse(result.stdout) : {}))
        .catch(err => {
            if (retries > 0) {
                logger.debug(`command failed, retrying: az ${args.join(' ')}: ${err.stderr}`);
                return sleep(errorSleep).then(() => az(args, retries - 1));
            } else {
                throw new Error(err.stderr || err);
            }
        });
}

function sleep(ms) {
    logger.debug(`sleeping for ${ms}ms...`);
    return new Promise(resolve => setTimeout(resolve, ms));
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
                logger.debug('Entry already exists in firewall!');
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
        .then(() => logger.info(`Server configured: ${server.name}`))
        .catch(err => {
            maybeShowErrorNotification(config);
            throw err;
        });
}

function maybeShowNotification(config, result, ipAddress) {
    if (config.notifications) {
        if (result.rulesCreated) {
            notifier.notify({
                title: 'Azure SQL Agent',
                message: `Firewall rules have been successfully updated for your public IP address ${ipAddress}`
            });
        } else {
            logger.debug('Not showing notification as no new rules were created');
        }
    }
}

function maybeShowErrorNotification(config) {
    if (config.errorNotifications !== false) {
        notifier.notify({
            title: 'Azure SQL Agent',
            message: `An error occured! Please see ~/.azure-sql-agent/agent.log for more details.`
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
            logger.debug(`Public IP: ${ipAddress}`);
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
    let help = false;
    let version = false;
    const options = {
        'debug': false,
        'foreground': false
    };
    for (const arg of process.argv.slice(2)) {
        if (arg === '-h' || arg === '--help') {
            help = true;
        } else if (arg === '-f' || arg === '--foreground') {
            options.foreground = true;
        } else if (arg === '-d' || arg === '--debug') {
            options.debug = true;
        } else if (arg === '--version') {
            version = true;
        } else {
            console.error(`Unknown argument: ${arg}`);
            help = true;
        }
    }
    if (help) {
        console.log(`usage: ${process.argv[1]} [-h] [-f] [-d]`);
        console.log();
        console.log('options:');
        console.log('  -h, --help        show this help message and exit');
        console.log('  -f, --foreground  run the agent in the foreground');
        console.log('  -d, --debug       show additional debugging output');
        console.log('  --version         show the version number and exit');
    } else if (version) {
        console.log(`version ${module.exports.version}`);
    } else {
        if (options.debug) {
            logger.level = 'debug';
        }
        if (options.foreground) {
            logger.add(winston.transports.Console);
            return runAgent();
        } else {
            const pid = fork();
            if (pid) {
                console.log(`Agent is running now: ${pid}`);
                return writePid(pid);
            } else {
                return runAgent();
            }
        }
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
            logger.error(err);
            process.exit(1);
        });
}

function watchConfigFile(ctx) {
    new Notify([configFile]).on('change', () => {
        logger.debug('Config file change detected!');
        ctx.forceSetRules = true;
    });
}

function mainLoop(ctx) {
    return Promise.resolve()
        .then(() => {
            if (ctx.forceSetRules) {
                if (ctx.publicIp) {
                    ctx.forceSetRules = false;
                    return true;
                } else {
                    // if this fails, we'll try again in the next loop
                    logger.debug('Full reload requested, but no public IP available!');
                    return publicIpChanged(ctx);
                }
            } else {
                return internalIpChanged(ctx)
                    .then(intChange => {
                        let checkPublic = false;
                        if (intChange) {
                            logger.debug('Internal IP changed!');
                            checkPublic = true;
                        } else if (!ctx.nextPublicCheck || Date.now() > ctx.nextPublicCheck) {
                            logger.debug('Public IP check timer triggered!');
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
                logger.debug('Setting firewall rules...');
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

#!/usr/bin/env node

const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const ip = require('ip');
const Promise = require('promise');
const spawn = require('child-process-promise').spawn;
const publicIp = require('public-ip');

const defaultConfig = {
    'prefix': 'my-prefix',
    'servers': [
        {
            'subscription': 'hex-subscription-id',
            'resourceGroup': 'resource-group-name',
            'name': 'server-name'
        }
    ]
};

function readConfig() {
    const home = os.homedir();
    const config = `${home}/.azure-sql-agent/config.json`;
    return fs.readJson(config)
        .catch(err => {
            if (err.code === 'ENOENT') {
                return fs.ensureDir(path.dirname(config))
                    .then(() => fs.writeJson(config, defaultConfig, { 'spaces': 2 }))
                    .then(() => console.log(`Default configuration written: ${config}`))
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

function setFirewallRule(config, server, ipAddress) {
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
                return removeRules.then(() => az(['sql', 'server', 'firewall-rule', 'create',
                    '-g', server.resourceGroup, '-s', server.name, '-n', ruleName,
                    '--start-ip-address', ipAddress, '--end-ip-address', ipAddress]));
            }
        })
        .then(() => console.log(`Server configured: ${server.name}`));
}

function forEachPromise(items, fn) {
    return items.reduce((promise, item) => promise.then(() => fn(item)), Promise.resolve());
}

function main() {
    return readConfig()
        .then(config => {
            return publicIp.v4().then(ipAddress => {
                console.log(`Public IP: ${ipAddress}`);
                const servers = config.servers || [];
                return forEachPromise(servers, server => setFirewallRule(config, server, ipAddress));
            });
        });
}

main()
    .catch(err => {
        console.error(err);
        process.exit(1);
    });

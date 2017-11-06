# azure-sql-agent

Command line agent to automatically add your current public IP address to the Azure SQL firewall.

![Screenshot](https://raw.githubusercontent.com/pascalgn/azure-sql-agent/master/screenshot.png)

## Installation

You will need the [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli?view=azure-cli-latest) installed.
Then just run

    $ yarn add azure-sql-agent
    $ ./node_modules/azure-sql-agent/lib/azure-sql-agent.js

You can also install the package globally: `yarn global add azure-sql-agent`

## Configuration

All SQL servers for which you want to automatically setup firewall rules have to be configured.
The configuration file is expected to be in `~/.azure-sql-agent/config.json`:

    {
        'prefix': 'my-prefix',
        'notifications': false,
        'servers': [
            {
                'subscription': 'hex-subscription-id',
                'resourceGroup': 'resource-group-name',
                'name': 'server-name'
            }
        ]
    }

The **prefix** is a personal name that is used to distinguish the firewall rules.
When running the agent, other rules with this prefix will be removed, as they are
expected to be old rules that have been created by earlier runs.

Set **notifications** to `true` if you would like to have a small window pop up
whenever the firewall rules have been updated.

The **subscription** is the full identifier of your Azure subscription.
You can see the currently active subscription in the `id` field when issueing `az account show`.
**resourceGroup** and **name** identify the specific SQL server.

## Usage

Make sure to run `az login` before you run the agent, as it requires an existing authentication.

After the configuration is complete, run the agent:

    $ ./node_modules/azure-sql-agent/lib/azure-sql-agent.js
    Agent is running now: 70295

To start the agent in the foreground, use `-f`.
A full list of options is displayed when using `--help`.

### Reloading

The agent automatically checks for changes in your internal IP address every second, assuming
that a new local IP address has been assigned due to switching the WiFi network, for example. This triggers
a check if your *public* IP has also changed.

Additionally, the agent checks if your public IP has changed every 5 minutes.

Any changes in your configuration file trigger a full reload, where all firewall rules will be
checked, regardless of any IP address changes. You could also trigger this reload manually by
using `touch ~/.azure-sql-agent/config.json`.

### Stopping

The process ID will be written to `~/.azure-sql-agent/agent.pid`. To stop the agent, you can run

    $ kill $(cat ~/.azure-sql-agent/agent.pid)

## License

The Azure SQL Agent is licensed under the MIT License

# azure-sql-agent

Command line agent to register rules in the Azure SQL firewall for the device the agent is running on.

See the *usage* section for an example.

## Installation

You will need the [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli?view=azure-cli-latest) installed.
Then just run

    $ yarn add azure-sql-agent
    $ ./node_modules/azure-sql-agent/bin/azure-sql-agent.js

You can also install the package globally: `yarn global add azure-sql-agent`

Then you have to configure the SQL servers for which you want to setup the rules.
The configuration file is expected to be in `~/.azure-sql-agent/config.json`:

    {
        'prefix': 'my-prefix',
        'servers': [
            {
                'subscription': 'hex-subscription-id',
                'resourceGroup': 'resource-group-name',
                'name': 'server-name'
            }
        ]
    }

The prefix is a personal name that is used to distinguish the firewall rules.
When running the agent, other rules with this prefix will be removed, as they are
expected to be old rules that have been created by earlier runs.

The subscription is the full identifier of your Azure subscription.
You can see the currently active subscription in the `id` field when issueing `az account show`.

## Usage

Make sure to run `az login` before you run the agent, as it requires an existing authentication.

After the configuration is complete, run the agent:

    $ ./node_modules/azure-sql-agent/bin/azure-sql-agent.js
    Public IP: 12.34.56.78
     -> az account set
     -> az sql server firewall-rule list
     -> az sql server firewall-rule create
    Server configured: server-name

## License

The Azure SQL Agent is licensed under the Apache License, Version 2.0

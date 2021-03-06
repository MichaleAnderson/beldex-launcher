# Requirements

- [nodejs](https://nodejs.org/en/) versions 8.x to 12.x are supported
- [npm](https://www.npmjs.com/get-npm) usually installed with nodejs (only for distribution and easy install of this software, we do not use ANY external NPMs for security reasons)
- Linux (though macos does works and Windows kind of works)
- xz (xz-utils apt package) to be able to download and extract updated Linux binaries
- setcap (apt: libcap2-bin, rpm: libcap) to be enable belnet to not need to run as root on Linux

# Why use the launcher over DEBs
The goal of the launcher is to make it easier to run a master node, however the DEBs installation and upgrade process can be much easier if you're running a debian-based OS. However we do have some additional advantages:
- Safer, we have additional checks in configuration, like to make sure you don't create port conflicts. We also have other checks that can detect unwanted patterns of behavior between apps and be able to take action
- Easier config management, one config file to manage all 3 binaries, also reduces the chance of you having to resolve config conflicts during upgrades
- Firewall Notification, lets you know if you're blocking any required ports. DEBs will open them in ufw but this won't help if you're using an different or external firewall. 
- NAT support, Launcher automatically configures your outgoing interface and public IP. DEBs you have to manually set up your network interface and public ip. Neither will help you set up port forwarding though.
- Prequal tool, know for sure your situation meets our minimum requirements
- Easy to downgrade path: if an upgrade is causing you problems, you can manually pull older releases off github and replace the binaries in /opt/beldex-launcher/bin and simply restart the launcher with the older binary until your node is stable.
- Diveristy of the network, in the highly unlikely event that Debian ever gets a serious bug, we want the master node network to be diverse enough to not be largely effective. Being able to support multiple operating systems is good for the Beldex ecosystem.
- Robust distribution system: Launcher relies on Microsoft/GitHub infrastructure, the DEBs are ran by our developer on his server. You could argue Microsoft/GitHub has more people keeping an eye on security and availability of their system. (And while we use NPM to distribute beldex-launcher we do not use any NPM modules in this project)
- Interactive client sessions, so you don't have beldexd start up delays for each command you want to run
- Unified subsystem reporting, get the status or versions of all 3 subsystems (blockchain, storage, network) from one command

Launcher is maintained at cost of the Beldex Foundation and if it's not found to be of use, maybe unfunded. Please consider supporting this great tool by using it.

# How to do a fresh master node install

This will use npm to install the launcher

`sudo npm install -g beldex-launcher`

This will create any needed directories and make sure everything has the proper permissions to run as a specified user such as `mnode` in this example

`sudo beldex-launcher set-perms mnode`

Now make sure sure you running the following commands as the user specified or you may run into permission problems (EPERM).

After it's installed, you can ask to prequalify your server to be a master node

`beldex-launcher prequal`

you can also ask it to download the Beldex binaries if you don't already have them

`beldex-launcher download-binaries`

# How to use without systemd

`beldex-launcher start`

Running it once should start the suite of services into the background or give you a message why it can't. This isn't recommended for long term uses as there is nothing to restart launcher if it dies/exits.

Running `beldex-launcher client`, will give you an interactive terminal to beldexd (the copy running from the current directory if you have multiple).
`exit` will stop your master node. If you just want to exit the interactive terminal, please use `ctrl-c`.

You can pass most [command line parameters](https://beldexdocs.com/Advanced/beldexd/) that you would give to beldexd to `beldex-launcher start`

You can make a launcher config file in /etc/beldex-launcher/launcher.ini and change various settings, [Check our wiki](https://github.com/beldex-project/beldex-launcher/wiki/Launcher.ini-configuration-documentation) for details on options.

# How to keep the launcher up to date

## Update your launcher without systemd

Stop your master node if it's running (you can use `beldex-launcher status` to check)

`beldex-launcher stop`

Update the launcher

`sudo npm install -g beldex-launcher`

And be sure to make sure you restart your master node (if it's staked) by

`beldex-launcher start`

## Get the latest Beldex software versions

`beldex-launcher download-binaries`

And be sure to make sure you restart your master node (if it's staked) by

`beldex-launcher start`

## Other

[upgrading from beldexd 3.0.6 with systemd to use the launcher](upgrading.md)

# Popular linux distribution instructions to install NodeJS

### CentOS NodeJS installation:

`curl -sL https://rpm.nodesource.com/setup_12.x | sudo bash -`

### Ubuntu/Debian NodeJS installation:

`curl -sL https://deb.nodesource.com/setup_12.x | sudo bash -`

then

`sudo apt-get install -y nodejs`



# Software the launcher manages

- [beldexd](https://github.com/beldex-project/beldex)
- [belnet](https://github.com/beldex-project/beldex-network)
- [beldex-storage](https://github.com/beldex-project/beldex-storage-server)

To get the required software you can run `beldex-launcher download-binaries` and they will be placed in `/opt/beldex-launcher/bin`

or

You can download the beldex binaries (faster) from each above page's release section

or

You can build from source. Make sure you select the correct repos/branches/versions as not all versions will work with each other.

And if you don't have the dependencies to build from source check out [contrib/dependency_helper/](contrib/dependency_helper/getDepsUnix.sh)

# Release Notes

Changelog items are now [available here](https://github.com/beldex-project/beldex-launcher/releases)

For more indepth details, be sure to check out our weekly [dev reports](https://beldex.network/blog/)

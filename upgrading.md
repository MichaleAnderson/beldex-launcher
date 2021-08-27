# How to upgrade to the launcher from running a beldexd 3.0.6 master node (set up with systemd)

1. Install nodejs (and npm) and then install the launcher as root:

`sudo npm install -g beldex-launcher`

2. Stop your existing master node:

`sudo systemctl stop beldexd.service`

3. Run the check-systemd to make systemd now launch the launcher instead of beldexd:

`sudo beldex-launcher check-systemd`

4. Make sure the service is up to date:

`sudo systemctl daemon-reload`

5. Start beldexd.service:

`sudo systemctl start beldexd.service`


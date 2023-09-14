# Install and run on Debian-based Linux (Ubuntu etc.)
- `sudo apt update`
- (optional) `sudo apt upgrade -y` (and then possibly `sudo reboot`)
- `sudo apt install -y ca-certificates curl gnupg`
- `sudo mkdir -p /etc/apt/keyrings && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg`
- `NODE_MAJOR=20 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list`
- `sudo apt-get update && sudo apt-get install nodejs -y`
- `sudo install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg && sudo chmod a+r /etc/apt/keyrings/docker.gpg`
- `echo "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null`
- `sudo apt-get update && sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y`
- `git clone https://github.com/martinambrus/dreamcatcher.git && cd dreamcatcher`
- `mv .env.dev.example .env`
- `mkdir -m 777 -p infrastructure/datadir/kafka_dev_data && mkdir -m 777 -p infrastructure/datadir/pgdata_dev && mkdir -m 777 -p infrastructure/datadir/kafka_0_data && mkdir -m 777 -p infrastructure/datadir/kafka_1_data && mkdir -m 777 -p infrastructure/datadir/kafka_2_data`
- `sudo chown -R 1001:1001 infrastructure/datadir/kafka_dev_data && sudo chown -R 1001:1001 infrastructure/datadir/pgdata_dev`
- `sudo chmod +x *.sh && sudo ./start_docker-dev.sh`

If you're on Windows under WSL and trying to run the Elastic Search cluster, you'll need to execute the following in your PowerShell or Elastic won't be able to start: `wsl -d docker-desktop sysctl -w vm.max_map_count=262144`

# Notes
- if you're developing, don't forget to run `npx prisma generate` in the [dreamcatcher-db](https://github.com/martinambrus/dreamcatcher-db) repository every time your database structure changes to keep your client updated!
# Install and run on Debian-based Linux (Ubuntu etc.)
- `sudo apt update`
- (optional) `sudo apt upgrade -y` (and then possibly `sudo reboot`)
- `sudo apt install curl`
- `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
- `sudo apt-get update && sudo apt-get install ca-certificates curl gnupg -y`
- `sudo install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg && sudo chmod a+r /etc/apt/keyrings/docker.gpg`
- `echo "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null`
- `sudo apt-get update && sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y`
- `git clone https://github.com/martinambrus/dreamcatcher.git && cd dreamcatcher`
- `mv .env.dev.example .env`
- `mkdir -m 777 -p infrastructure/datadir/kafka_0_data && mkdir -m 777 -p infrastructure/datadir/kafka_1_data && mkdir -m 777 -p infrastructure/datadir/kafka_2_data && mkdir -m 777 -p infrastructure/datadir/pgdata_secondary`
- `sudo chmod +x *.sh && sudo ./start_docker-dev.sh`

If you're on Windows under WSL and trying to run the Elastic Search cluster, you'll need to execute the following in your PowerShell or Elastic won't be able to start: `wsl -d docker-desktop sysctl -w vm.max_map_count=262144`

# Notes
- if you're developing, don't forget to run `npx prisma generate` the [dreamcatcher-db](https://github.com/martinambrus/dreamcatcher-db) repository every time your database structure changes to keep your client updated!

Just to have it here - this is an excellent `top` replacement that works via a web browser and can run on your system via Docker: https://glances.readthedocs.io/en/latest/docker.html
Run it like this to access it via http://localhost:61208: `docker run -d --restart="always" -p 61208-61209:61208-61209 -e GLANCES_OPT="-w" -v /var/run/docker.sock:/var/run/docker.sock:ro --pid host docker.io/nicolargo/glances`
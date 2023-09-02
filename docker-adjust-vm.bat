:: This file is for Windows WSL, which has a too low vm.max_map_count set and Elastic servers
:: are unable to start without increasing that value.
wsl -d docker-desktop sysctl -w vm.max_map_count=262144
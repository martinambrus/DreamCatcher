# this script removes all files in all data directories, including old Jaeger and Kafka logs and DB data
sudo rm -rf infrastructure/datadir/jaeger/*
sudo rm -rf infrastructure/datadir/elastic/*
sudo rm -rf infrastructure/datadir/kafka_dev_data/*
sudo rm -rf infrastructure/datadir/pgdata_dev/*
sudo rm -rf infrastructure/datadir/pgdata_dev/.*
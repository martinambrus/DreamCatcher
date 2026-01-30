This is dreamcatcher-db - a helper repository for the [DreamCatcher](https://github.com/martinambrus/DreamCatcher/) project.
On its own, it provides functionality for the PostgreSQL relational database used in this project.
However, this repository does not contain any code that you can run. You can only build upon the foundation of it.

In order to update the Prisma client used in this repository, you will need to install NPM packages and run the following command: `npx prisma generate`.
This will update the client schema and definitions as per the latest database structure. Just make sure the DB is running in Docker and that its port is accessible via localhost.

This repository also helps to keep the code in all of the microservices using a message queue up to date with latest changes and fixes.

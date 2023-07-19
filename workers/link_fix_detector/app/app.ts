import {env, exit} from 'node:process';
import { Logger } from "./Logger.js";
import { RedisClient } from "./RedisClient.js";
import { LinkFixDetector } from "./LinkFixDetector.js";
import pkg from 'pg';

const { Client } = pkg;

// PGSQL settings
const POSTGRES_HOST: string = env.POSTGRES_HOST;
const POSTGRES_USER: string = env.POSTGRES_USER;
const POSTGRES_PASSWORD: string = env.POSTGRES_PASSWORD;
const POSTGRES_DB: string = env.POSTGRES_DB;

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? env.HOSTNAME : 'analysis_undefined_host' );
const SERVICE_ID: string = 'analysis';

( async (): Promise<void> => {

  // Global logger
  const logger: Logger = new Logger(CLIENT_ID, SERVICE_ID);

  // Redis publishing client
  const redis_pub_client: RedisClient = new RedisClient(env.REDIS_HOSTNAME, env.REDIS_PORT, logger, CLIENT_ID);
  await redis_pub_client.connect();
  logger.set_redis_pub_client(redis_pub_client);

  // Redis subscribing client
  const redis_sub_client: RedisClient = new RedisClient(env.REDIS_HOSTNAME, env.REDIS_PORT, logger, CLIENT_ID);
  await redis_sub_client.connect();

  // PGSQL class instance
  const dbconn: pkg.Client = new Client({
    host: POSTGRES_HOST,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DB
  });

  // try connecting to PGSQL
  if (!POSTGRES_DB || !POSTGRES_PASSWORD || !POSTGRES_USER) {
    logger.log_msg('missing one of POSTGRES environment variables', parseInt(await redis_pub_client.get('ERR_POSTGRES_MISSING_CONNECTION_DATA')));
    exit();
  } else {
    // try to connect to PGSQL
    try {
      await dbconn.connect();
    } catch (err) {
      logger.log_msg('could not connect to POSTGRES\n' + err.toString(), parseInt(await redis_pub_client.get('ERR_POSTGRES_CANNOT_CONNECT')));
      exit();
    }
  }

  // create the Analysis class instance and run program
  new LinkFixDetector(redis_sub_client, redis_pub_client, logger, dbconn);
})();
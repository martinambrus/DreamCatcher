import { env, exit } from "node:process";
import { exec } from "node:child_process";
import { ExecException } from "child_process";
import { Logger } from "./Logger.js";
import { RedisClient } from "./RedisClient.js";
import pkg from "pg";

/**
 * Enumeration of LOG severities.
 */
export enum LOG_SEVERITIES {

  LOG_SEVERITY_ERROR = 'error',
  LOG_SEVERITY_LOG = 'log',

}

export class ControlCenter {

  /**
   * Instance of the Logger class.
   * @private
   * @type { Logger }
   */
  private readonly logger: Logger;

  /**
   * Instance of the RedisClient used for message publishing
   * sections of the code.
   * @private
   * @type { RedisClient }
   */
  private readonly redis_pub_client: RedisClient;

  /**
   * PostgreSQL client class instance.
   * @private
   * @type { pkg.Client }
   */
  private readonly dbconn: pkg.Client;

  /**
   * Stores references to Redis, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { RedisClient } redis_pub_client Redis client used to publish to Redis channels.
   * @param { Logger }      logger A Logger class instanced used for logging purposes.
   * @param { pkg.Client }  dbconn A PGSQL client instance.
   */
  constructor( redis_pub_client: RedisClient, logger: Logger, dbconn: pkg.Client ) {

    this.redis_pub_client = redis_pub_client;
    this.logger = logger;
    this.dbconn = dbconn;

    // publish info about our instance going live
    this.logger.log_msg( 'control center up and running, checking feeds every ' + env.RSS_CHECK_INTERVAL_SECONDS + ' seconds', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // run a notification script to fetch new articles every 5 minutes
    setInterval( async function() {
      // first, update all feeds with 10+ subsequent failures
      // where last fetch was more than 2 days ago
      await self.dbconn.query(`
    UPDATE feeds SET
      subsequent_errors_counter = 0,
      last_error_ts = 0,
      fetch_interval_minutes = 5,
      subsequent_stable_fetch_intervals = 0
    WHERE
      subsequent_errors_counter > 10
      AND
      last_error_ts > ` + ( Date.now() - (60 * 60 * 24 * 2) ) // now minus 2 days
      );

      // assemble all feeds with the following parameters:
      // -> at least 1 normal/premium user subscribed
      // -> next_fetch_ts >= current time
      // -> subsequent errors counter less than 10
      try {
        let res = await self.dbconn.query(`
      SELECT url FROM feeds WHERE
        ( normal_subscribers > 0 OR premium_subscribers > 0 )
        AND
        (
          ( next_fetch_ts = 0 OR next_fetch_ts <= ${Date.now()} )
          AND
          subsequent_errors_counter < 10
        )
    `);

        for ( let i in res.rows ) {
          // fire up rss fetch containers
          self.run_rss_fetch_container( i, res.rows[ i ].url );
        }
      } catch ( err ) {
        self.logger.log_msg( 'Exception while trying to save retrieve rss feeds to fetch\n' + err.toString(), parseInt( await self.redis_pub_client.get( 'ERR_CONTROL_CENTER_DB_ERROR' ) ) );
        await self.dbconn.end();
        exit(); // docker will restart the container, so we'll start clean
      }
    }, 1000 * parseInt( env.RSS_CHECK_INTERVAL_SECONDS ) ); // run every 5 minutes (default)
  }

  private run_rss_fetch_container( container_id: string, feed_url: string ) {
    exec( 'docker compose -f docker-compose.yml -f <(echo -e "services:\\n  ' + env.RSS_SERVICE_NAME + ':\\n    container_name: ' + env.RSS_SERVICE_NAME + '_' + container_id + '\n    hostname: ' + env.RSS_SERVICE_NAME + '_' + container_id + '\n    environment:\\n      - TEST_RUN=0\\n      - FEED_URL=' + feed_url + '") run -d --rm rss_fetch', {shell: "/bin/bash"}, async (error: ExecException, stdout: string, stderr: string): Promise<void> => {
      if (error) {
        this.logger.log_msg( 'Error (1) starting rss_fetch container for feed ' + feed_url + '\n' + error.toString(), parseInt( await this.redis_pub_client.get( 'ERR_CONTROL_CENTER_CANNOT_START_CONTAINER' ) ) );
        return;
      }

      // for some reason, docker will write an OK message directly into stderr,
      // so we need to handle that here, since it obviously is not an error
      if (stderr && stderr.indexOf(' Running') == -1 ) {
        this.logger.log_msg( 'Error (2) starting rss_fetch container for feed ' + feed_url + '\n' + stderr, parseInt( await this.redis_pub_client.get( 'ERR_CONTROL_CENTER_CANNOT_START_CONTAINER' ) ) );
        return;
      }

      console.log( this.logger.get_log(`started rss_fetch container for ${feed_url}, stdout: ${stdout}`) );
    });
  }
}
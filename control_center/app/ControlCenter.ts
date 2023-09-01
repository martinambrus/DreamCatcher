import { env, exit } from "node:process";
import pkg from "pg";
import { Telemetry } from './Telemetry.js';
import { ILogger, LOG_SEVERITIES } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IKeyStoreSub } from './MQ/KeyStore/Interfaces/IKeyStoreSub.js';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { IMessageQueuePub } from './MQ/KeyStore/Interfaces/IMessageQueuePub.js';

export class ControlCenter {

  /**
   * Current version of this service.
   * Must be changed for each production-ready release.
   * @private
   * @type { string }
   */
  private readonly version: string = '0.1a';

  /**
   * Instance of the Logger class.
   * @private
   * @type { ILogger }
   */
  private readonly logger: ILogger;

  /**
   * Instance of the MQ Producer used for message publishing
   * sections of the code.
   * @private
   * @type { IMessageQueuePub }
   */
  private readonly mq_producer: IMessageQueuePub;

  /**
   * Key store subscriber client instance,
   * used to subscribe to channels.
   * @type { IKeyStoreSub }
   * @private
   */
  private readonly key_store_sub: IKeyStoreSub;

  /**
   * Key Store publisher and getter client instance,
   * used to fetch error codes.
   * @type { IKeyStorePub }
   * @private
   */
  private readonly key_store_pub: IKeyStorePub;

  /**
   * PostgreSQL client class instance.
   * @private
   * @type { pkg.Client }
   */
  private readonly dbconn: pkg.Client;

  /**
   * List of all known services that need to send activation message
   * via key store, so the Control Center knows we are in a healthy state
   * and can start checking for RSS feeds in need of fetching.
   * @private
   * @type { Array<string> }
   */
  private readonly all_services_list: Array<string> = [ 'analysis', 'err_log_writer', 'link_fix_detector', 'link_writer', 'rss_fetch' ];

  /**
   * List of all known tail-end services that work with telemetry,
   * so we can close the root span when all of them are done with it.
   * @private
   * @type { Array<string> }
   */
  private readonly telemetry_tail_services_list: Array<string> = [ 'analysis' ];

  /**
   * When this is true, we are in an active state
   * and can process feed data from database.
   * @private
   * @type { boolean }
   */
  private active: boolean = false;

  /**
   * An array of active Jaeger root spans which is used
   * to check for activity timeout on any of them.
   * If an activity timeout is reached, we will close
   * that span and thus complete the full trace, while
   * also marking it with an error status (because not all
   * required services responded in its lifecycle).
   * @private
   * @type { Array< Telemetry > }
   */
  private active_telemetries: Array< Telemetry > = [];

  /**
   * Maximum number of seconds for a trace to be without
   * any activity in order to consider it inactive and auto-close it.
   * @private
   * @type { number }
   */
  private readonly telemetry_inactive_timeout_seconds: number = 300;

  /**
   * Service name used in telemetry tracing.
   * @private
   * @type { string }
   */
  private service_name: string;

  /**
   * Holds trace IDs of currently active telemetries
   * and all services that finished work on that trace ID.
   * For these services, this object has a status and once
   * all of the services are marked as done, the telemetry
   * is ended in the main app.
   * Format: { 'trace_id_1234' : { 'app1' : false, 'app2' : false } }
   * @private
   * @type { Object }
   */
  private telemetry_services_completions: Object = {};

  /**
   * Stores references to key store, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }           service_name  Name of the service. Used for Jaeger tracing identification.
   * @param { IMessageQueuePub } mq_producer   MQ Producer used to publish messages.
   * @param { ILogger }          logger        A Logger class instanced used for logging purposes.
   * @param { pkg.Client }       dbconn        A PGSQL client instance.
   * @param { IKeyStoreSub }     key_store_sub A Key Store Sub client to subscribe to channels.
   * @param { IKeyStorePub }     key_store_pub A Key Store Pub client to fetch error codes.
   */
  constructor( service_name: string, mq_producer: IMessageQueuePub, logger: ILogger, dbconn: pkg.Client, key_store_sub: IKeyStoreSub, key_store_pub: IKeyStorePub ) {
    this.service_name = service_name;
    this.mq_producer = mq_producer;
    this.logger = logger;
    this.dbconn = dbconn;
    this.key_store_sub = key_store_sub;
    this.key_store_pub = key_store_pub;

    // publish info about our instance going live
    this.logger.log_msg( 'control center up and running, checking feeds every ' + env.RSS_CHECK_INTERVAL_SECONDS + ' seconds', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    // keep checking for a key store status where all services write their active states,
    // and if there's any service not active yet, wait until ALL are active
    // ... check every minute - in case key store server drops, all services will re-submit their OK states into it
    //     when it runs again
    setInterval( this.services_status_check.bind( this ), 57000);

    // run a notification script to fetch new articles every X minutes ( default is 1 minute )
    setInterval( this.fetch_feeds.bind( this ), 1000 * parseInt( env.RSS_CHECK_INTERVAL_SECONDS ) );

    // keep checking for timed out Jaeger telemetries and close them when they do time out
    // ... check every minute (actually 63 seconds because the telemetry timeout is set to 300s exactly)
    setInterval( this.check_and_close_timed_out_telemetries.bind( this ), 63000);

    // watch for telemetry messages from other services, so we can close the root span as needed
    this.key_store_sub.subscribe( env.TELEMETRY_CHANNEL_NAME, this.watch_telemetry_messages.bind( this ) );
  }

  /**
   * When a new message from the telemetry key store channel arrives,
   * this method will detect whether it's coming from one of the tail-end
   * services. If so, we'll check whether all tail-end services processed
   * the given trace and close the root span for it.
   *
   * This message also refreshes last active timestamp for the given
   * active telemetry.
   *
   * @param { string } message Message from key store.
   * @private
   */
  private watch_telemetry_messages( message: string ): void {
    try {
      const msg = JSON.parse( message );

      if ( msg.service && msg.trace_id ) {
        // this is still an unparsed JSON string, so we need to parse it again
        try {
          msg.trace_id = JSON.parse( msg.trace_id );
        } catch ( err ) {
          // if trace ID is not parsable, it's probably an error log message
          // and doesn't have anything to do with any active telemetry - so just ignore it
          return;
        }

        // set last active TS of the present telemetry
        for ( let telemetry_instance of this.active_telemetries ) {
          if ( telemetry_instance.get_telemetry_carrier_raw()[ 'traceparent' ] == msg.trace_id.traceparent ) {
            telemetry_instance.bump_last_activity();
            break;
          }
        }

        if ( this.telemetry_tail_services_list.indexOf( msg.service ) > -1 ) {
          // set telemetry for this service as ended
          this.telemetry_services_completions[ msg.trace_id.traceparent ][ msg.service ] = true;

          // check whether we have any service left to write to this telemetry
          let all_done: boolean = true;
          for ( let service_name in this.telemetry_services_completions[ msg.trace_id.traceparent ] ) {
            if ( !this.telemetry_services_completions[ msg.trace_id.traceparent ][ service_name ] ) {
              all_done = false;
              break;
            }
          }

          // if all is done, close the root span
          if ( all_done ) {
            let new_active_telemetries: Array< Telemetry > = [];

            for ( let telemetry_instance of this.active_telemetries ) {
              if ( telemetry_instance.get_telemetry_carrier_raw()[ 'traceparent' ] == msg.trace_id.traceparent ) {
                telemetry_instance.close_root_span();
              } else {
                new_active_telemetries.push( telemetry_instance );
              }
            }

            this.active_telemetries = new_active_telemetries;
          }
        }
      } else {
        throw 'missing message data (service or trace_id)';
      }
    } catch ( err ) {
      this.logger.log_msg( 'Invalid telemetry channel message: ' + message + '\nError reported: ' + JSON.stringify( err ), 'ERR_TELEMETRY_CHANNEL_MESSAGE_INVALID' );
    }
  }

  /**
   * Checks for status of all relevant backend services
   * and stops the feed-fetch procedure is any of them
   * are currently unavailable.
   * @private
   */
  private async services_status_check(): Promise<void> {
    let all_active: boolean = true;

    for ( let service_name of this.all_services_list ) {
      // check key store for active state of the service
      if ( await this.key_store_pub.get( service_name + '_active' ) !== '1' ) {
        all_active = false;
        console.log( this.logger.format( 'service ' + service_name + ' not ready' ) );
      }
    }

    // wait until all services are active - set our active flag to false if they aren't
    this.active = all_active;
  }

  /**
   * Checks which feeds in the database need fetching
   * and publishes relevant MQ messages, so they can be
   * parsed by the listening services.
   * @private
   */
  private async fetch_feeds(): Promise<void> {
    if ( this.active ) {
      // first, update all feeds with 10+ subsequent failures
      // where last fetch was more than 2 days ago
      await this.dbconn.query('SELECT update_old_failed_feeds()');

      // assemble all feeds with the following parameters:
      // -> at least 1 normal/premium user subscribed
      // -> next_fetch_ts >= current time
      // -> subsequent errors counter less than 10
      try {
        let res = await this.dbconn.query( 'SELECT * FROM fetchable_feeds' );

        for ( let i in res.rows ) {
          // send RSS feed URLs to the rss_fetch service for processing
          // note: we don't use await here, so we can fire up MQ messages fast
          const lifecycle_telemetry: Telemetry = await new Telemetry( this.service_name, this.version, res.rows[ i ].url ).start();
          const pub_feed_span_name: string = 'mq_pub_feed';

          await lifecycle_telemetry.add_span( pub_feed_span_name );
          this.active_telemetries.push( lifecycle_telemetry );

          // store this trace ID against all tail-end telemetry services,
          // so we can check whether the trace has gone through completely
          // and close it later
          let trace_id: any = lifecycle_telemetry.get_telemetry_carrier_raw();

          this.telemetry_services_completions[ trace_id.traceparent ] = {};
          for ( let service_name of this.telemetry_tail_services_list ) {
            this.telemetry_services_completions[ trace_id.traceparent ][ service_name ] = false;
          }

          await this.mq_producer.send( env.FEED_FETCH_CHANNEL_NAME, { url: res.rows[ i ].url }, JSON.stringify( trace_id ), res.rows[ i ].url );
          lifecycle_telemetry.close_active_span( pub_feed_span_name );
        }
      } catch ( err ) {
        let exit_code: number = parseInt( await this.key_store_pub.get( 'ERR_CONTROL_CENTER_DB_ERROR' ) );
        await this.logger.log_msg( 'Exception while trying to retrieve rss feeds to fetch\n' + JSON.stringify( err ), exit_code );
        await this.dbconn.end();
        exit( exit_code ); // docker will restart the container, so we'll start clean
      }
    } else {
      console.log( this.logger.format( 'RSS processing is paused, not all services are currently healthy' ) );
    }
  }

  /**
   * When a telemetry did not receive any action
   * for a prolonged time period, close the parent span
   * automatically here.
   * @private
   */
  private check_and_close_timed_out_telemetries(): void {
    let
      new_active_telemetries: Array< Telemetry > = [],
      current_timestamp: number = Math.round( Date.now() / 1000 );

    for ( let telemetry_instance of this.active_telemetries ) {
      // check whether this telemetry was inactive long enough
      if ( current_timestamp - telemetry_instance.get_last_activity() > this.telemetry_inactive_timeout_seconds ) {
        telemetry_instance.add_span('error_log', { err: 'Telemetry timed out.' }, '', 1 ).then( () => {
          telemetry_instance.close_active_span( 'error_log' );
          telemetry_instance.close_root_span();
        });
      } else {
        new_active_telemetries.push( telemetry_instance );
      }
    }

    if ( new_active_telemetries.length != this.active_telemetries.length ) {
      this.active_telemetries = new_active_telemetries;
    }
  }
}
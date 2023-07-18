import { env, exit } from 'node:process';
import { setTimeout } from 'timers/promises';
import { createClient } from "redis";
import {Logger} from "./Logger.js";

export class RedisClient {

  /**
   * Redis client
   * @type { any }
   * @private
   */
  private client: any;

  /**
   * Redis new links channel name.
   * @private
   */
  private redis_new_links_channel: string;

  /**
   * Redis logs channel name.
   * @private
   */
  private redis_logs_channel: string;

  /**
   * Client identifies (such as pub or sub client).
   * @private
   */
  private client_id: string = 'pub';

  /**
   * Determines whether the Redis client was successfully connected.
   * @type { boolean }
   * @private
   */
  private client_ready: boolean = false;

  /**
   * A logger class instance.
   * @type { Logger }
   * @private
   */
  private logger: Logger;

  /**
   * Defines internal Redis constants and creates a Redis connection,
   * based off the connection data received.
   * @constructor
   */
  constructor(hostname: string, port: string, logger: Logger, client_id?: string) {
    // define constants
    this.redis_new_links_channel = env.REDIS_NEW_LINKS_CHANNEL;
    this.redis_logs_channel = env.REDIS_LOGS_CHANNEL;

    this.logger = logger;

    if ( client_id ) {
      this.client_id = client_id;
    }

  }

  /**
   * Initializes the Redis client and connects to Redis instance.
   */
  public async connect(): Promise<void> {
    // wait 5 seconds for other containers to start and init
    await setTimeout( 5000 );

    // create a Redis client
    this.client = createClient( { url: 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT } );

    // add error handling for cases when we can't connect to a Redis server
    this.client.on( 'error', ( err: any ): void => {
      if ( !this.client_ready ) {
        console.log( this.logger.get_log( 'Exception while trying to connect to Redis (' + this.client_id + ' ) via ' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT + "\n" + err.toString() ) );
        exit( 1 );
      }
    });

    // on successful ready state, mark the client as ready
    this.client.on( 'ready', (): void => {
      this.client_ready = true;
      console.log( this.logger.get_log( 'successfully connected to REDIS (' + this.client_id + ') at ' + 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT ) );
    });

    await this.client.connect();

    // test that we can publish
    await this.client.publish( 'TEST_RUN', this.client_id );
  }

  /**
   * Publishes a new feed link data.
   *
   * @param object msg Feed data to publish.
   * @return void
   * @public
   */
  public pub_link( msg: object ):void {
    try {
      this.client.publish( this.redis_new_links_channel, JSON.stringify( msg ) );
    } catch ( err ) {
      let dt: Date = new Date();
      console.log( '[' + dt.getDate() + '.' + dt.getMonth() + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] Error publishing Redis link data:\n' + msg + '\n', err );
    }
  }

  /**
   * A proxy for the Redis->subscribe() method.
   *
   * @param { string }   channel  Channel to subscribe to.
   * @param { Function } callback Callback function to call when a message arrives.
   */
  public subscribe( channel: string, callback: Function ): void {
    this.client.subscribe( channel, callback );
  }

  /**
   * Publishes new log data.
   *
   * @param object msg Log data to publish.
   * @return void
   * @public
   */
  public log_msg( msg: object ):void {
    try {
      this.client.publish( this.redis_logs_channel, JSON.stringify( msg ) );
    } catch ( err ) {
      let dt: Date = new Date();
      console.log( '[' + dt.getDate() + '.' + dt.getMonth() + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] Error publishing Redis log data:\n' + msg + "\n", err );
    }
  }

  /**
   * A proxy for the Redis->get() method.
   *
   * @param string key The key to get value for from Redis.
   * @return Promise<string> Returns a promise that resolves into a string value.
   * @public
   */
  public async get( key: string ):Promise<string> {
    try {
      return await this.client.get( key );
    } catch ( err ) {
      let dt: Date = new Date();
      console.log( '[' + dt.getDate() + '.' + dt.getMonth() + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] Error reading Redis key ' + key + '\n', err );
      return '';
    }
  }
}
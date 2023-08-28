import { exit } from 'node:process';
import { Logger } from "./Logger.js";
import { Redis } from 'ioredis';

export class RedisPubClient {

  /**
   * Redis client
   * @type { Redis }
   * @private
   */
  private client: Redis;

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
   * Stores a logger class instance.
   * @param { Logger } logger The logger class instance.
   * @constructor
   */
  constructor( logger: Logger ) {
    this.logger = logger;
  }

  /**
   * Initializes the Redis client and connects to Redis instance.
   *
   * @param { string } url  Either a single redis hostname (if the second port parameter is set)
   *                        or a string containing URLs for a Redis cluster.
   * @param { string } port Redis port.
   */
  public async connect( url: string, port: string = null ): Promise<void> {
    if ( port ) {
      // create a Redis client
      // @ts-ignore
      this.client = new Redis({
        port: port,
        host: url,
      });
    } else{
      // create a Redis cluster
      let
        cluster: Array<string> = url.split(','),
        connection_object: { name: string, sentinels: Array<{ host: string, port: string }> } = { name: 'main', sentinels: [] };
      for ( let node_string of cluster ) {
        let node_string_parsed = node_string.split(':');
        connection_object.sentinels.push( { host: node_string_parsed[ 0 ], port: node_string_parsed[ 1 ] } );
      }

      // @ts-ignore
      this.client = new Redis( connection_object );
    }

    // add error handling for cases when we can't connect to a Redis server
    this.client.on( 'error', ( err: any ): void => {
      if ( !this.client_ready ) {
        console.log( this.logger.get_log( 'Exception while trying to connect to Redis (Pub) via ' + url + ':' + port + "\n" + JSON.stringify( err ) ) );
        exit( 1 );
      }
    });

    // on successful ready state, mark the client as ready
    this.client.on( 'ready', (): void => {
      this.client_ready = true;
      console.log( this.logger.get_log( 'Redis Pub successfully connected to Redis via ' + url + ( port ? ':' + port : '' ) ) );
    });
  }

  /**
   * A proxy for Redis->get().
   *
   * @param { string } key The key for which we want to retrieve a value.
   */
  public async get( key: string ): Promise<string> {
    return this.client.get( key );
  }

  /**
   * A proxy for Redis->set().
   *
   * @param { string } key   The key for which we want to set a value.
   * @param { string } value The value we want to set.
   */
  public async set( key: string, value: any ): Promise<string> {
    return this.client.set( key, value );
  }

  /**
   * A proxy for Redis->publish()
   *
   * @param { string } channel Channel into which we want to publish a message.
   * @param { string } message The message we want to publish.
   */
  public async publish( channel: string, message: string ): Promise<number> {
    return this.client.publish( channel, message );
  }
}
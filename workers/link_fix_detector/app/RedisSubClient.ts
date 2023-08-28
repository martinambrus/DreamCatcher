import { exit } from 'node:process';
import { Redis } from "ioredis"
import { Logger } from "./Logger.js";

export class RedisSubClient {

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
        console.log( this.logger.get_log( 'Exception while trying to connect to Redis (Sub) via ' + url + ( port ? ':' + port : '' ) + "\n" + JSON.stringify( err ) ) );
        exit( 1 );
      }
    });

    // on successful ready state, mark the client as ready
    this.client.on( 'ready', (): void => {
      this.client_ready = true;
      console.log( this.logger.get_log( 'Redis Sub successfully connected to Redis via ' + url + ( port ? ':' + port : '' ) ) );
    });
  }

  /**
   * A proxy for Redis->subscribe()
   *
   * @param { string }   channel  Name of the channel to subscribe to.
   * @param { Function } callback Function to be executed when a new message from our channel arrives.
   */
  public subscribe( channel: string, callback: any ) {
    this.client.subscribe( channel, callback );
  }
}
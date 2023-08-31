import { exit } from 'node:process';
import { ILogger } from "./Interfaces/ILogger.js";
import { Redis } from 'ioredis';

export class RedisClientBase {

  /**
   * Redis client
   * @type { Redis }
   * @protected
   */
  protected client: Redis;

  /**
   * Determines whether the Redis client was successfully connected.
   * @type { boolean }
   * @protected
   */
  protected client_ready: boolean = false;

  /**
   * A logger class instance.
   * @type { ILogger }
   * @protected
   */
  protected logger: ILogger;

  /**
   * Redis client identification (pub / sub).
   * Used for logging purposes.
   *
   * @type { string }
   * @protected
   */
  protected name: string;

  /**
   * Stores a logger class instance.
   *
   * @param { string }  name   Name of this instance ( pub / sub ) for logging purposes.
   * @param { ILogger } logger The logger class instance.
   * @constructor
   */
  constructor( name: string, logger: ILogger ) {
    this.name = name;
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
        console.log( this.logger.format( 'Exception while trying to connect to Redis (' + this.name + ') via ' + url + ':' + port + "\n" + JSON.stringify( err ) ) );
        exit( 1 );
      }
    });

    // on successful ready state, mark the client as ready
    this.client.on( 'ready', (): void => {
      this.client_ready = true;
      console.log( this.logger.format( 'Successfully connected to Redis (' + this.name + ') via ' + url + ( port ? ':' + port : '' ) ) );
    });
  }
}
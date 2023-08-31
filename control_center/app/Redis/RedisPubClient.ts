import { IRedisPub } from './Interfaces/IRedisPub.js';
import { RedisClientBase } from './RedisClientBase.js';
import { ILogger } from './Interfaces/ILogger.js';

export class RedisPubClient extends RedisClientBase implements IRedisPub {

  /**
   * Stores a logger class instance.
   *
   * @param { ILogger } logger The logger class instance.
   * @constructor
   */
  constructor( logger: ILogger ) {
    super( 'Pub', logger );
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
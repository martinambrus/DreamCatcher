import { IRedisSub } from './Interfaces/IRedisSub.js';
import { RedisClientBase } from './RedisClientBase.js';
import { ILogger } from './Interfaces/ILogger.js';

export class RedisSubClient extends RedisClientBase implements IRedisSub {

  /**
   * Stores a logger class instance.
   *
   * @param { ILogger } logger The logger class instance.
   * @constructor
   */
  constructor( logger: ILogger ) {
    super( 'Sub', logger );
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
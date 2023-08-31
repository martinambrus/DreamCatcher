/**
 * Interface for Redis subscribing client.
 */
export interface IRedisSub {

  /**
   * Initializes the Redis client and connects to Redis instance.
   *
   * @param { string } url  Either a single redis hostname (if the second port parameter is set)
   *                        or a string containing URLs for a Redis cluster.
   * @param { string } port Redis port.
   */
  connect( url: string, port: string ): Promise<void>;

  /**
   * A proxy for Redis->subscribe()
   *
   * @param { string }   channel  Name of the channel to subscribe to.
   * @param { Function } callback Function to be executed when a new message from our channel arrives.
   */
  subscribe( channel: string, callback: any );

}
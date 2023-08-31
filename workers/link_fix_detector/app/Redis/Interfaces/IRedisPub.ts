/**
 * Interface for Redis publishing client.
 */
export interface IRedisPub {

  /**
   * Initializes the Redis client and connects to Redis instance.
   *
   * @param { string } url  Either a single redis hostname (if the second port parameter is set)
   *                        or a string containing URLs for a Redis cluster.
   * @param { string } port Redis port.
   */
  connect( url: string, port: string ): Promise<void>;

  /**
   * A proxy for Redis->get().
   *
   * @param { string } key The key for which we want to retrieve a value.
   */
  get( key: string ): Promise<string>;

  /**
   * A proxy for Redis->set().
   *
   * @param { string } key   The key for which we want to set a value.
   * @param { string } value The value we want to set.
   */
  set( key: string, value: any ): Promise<string>;

  /**
   * A proxy for Redis->publish()
   *
   * @param { string } channel Channel into which we want to publish a message.
   * @param { string } message The message we want to publish.
   */
  publish( channel: string, message: string ): Promise<number>;

}
<?php
namespace martinambrus;

/**
 * Redis connection class that handles publishing of messages.
 */
class Redis {

  /**
   * @var \Redis Redis client.
   */
  private \Redis $client;

  /**
   * Defines internal Redis constants and creates a Redis connection,
   * based off the connection data received.
   *
   * @throws \Exception When redis connection would not be made.
   */
  public function __construct( string $hostname, string $port ) {
    define( __NAMESPACE__ . '\REDIS_NEW_LINKS_CHANNEL', getenv( 'REDIS_NEW_LINKS_CHANNEL' ) );
    define( __NAMESPACE__ . '\REDIS_LOGS_CHANNEL', getenv( 'REDIS_LOGS_CHANNEL' ) );

    // create publishing client
    $this->client = new \Redis();

    // try to connect
    $this->client->connect( $hostname, $port );

    try {
      // this is here to test Redis publishing, nothing more - the actual channel message isn't being received by anyone
      $this->client->publish('TEST_RUN', 'REDIS_TEST' );
    } catch ( \Exception $e ) {
      echo 'Exception while trying to publish to Redis (' . $hostname . ':' . $port . ")\n" . $e->getMessage() . ' in ' . $e->getFile() . ' on line ' . $e->getLine();
      exit;
    }
  }

  /**
   * Publishes a new feed link data.
   *
   * @param array $msg Feed data to publish.
   *
   * @return void
   */
  public function pub_link( array $msg ):void {
    try {
      $this->client->publish( REDIS_NEW_LINKS_CHANNEL, json_encode( $msg ) );
    } catch ( \Exception $e ) {
      echo '[' . gmdate( 'j.m.Y H:i:s' ) . "] Error publishing Redis link data:\n" . $msg . "\n" . $e->getMessage() . ' in file ' . $e->getFile() . ' on line ' . $e->getLine() . "\n";
    }
  }

  /**
   * Publishes new log data.
   *
   * @param array $msg Log data to publish.
   *
   * @return void
   */
  public function log_msg( array $msg ):void {
    try {
      $this->client->publish( REDIS_LOGS_CHANNEL, json_encode( $msg ) );
    } catch ( \Exception $e ) {
      echo '[' . gmdate( 'j.m.Y H:i:s' ) . "] Error publishing Redis log data:\n" . $msg . "\n" . $e->getMessage() . ' in file ' . $e->getFile() . ' on line ' . $e->getLine() . "\n";
    }
  }

  /**
   * A proxy for the \Redis->get() method.
   *
   * @param string $key The key to get value for from Redis.
   *
   * @return mixed
   */
  public function get( string $key ):mixed {
    try {
      return $this->client->get( $key );
    } catch ( \Exception $e ) {
      echo '[' . gmdate( 'j.m.Y H:i:s' ) . "] Error reading Redis key $key\n" . $e->getMessage() . ' in file ' . $e->getFile() . ' on line ' . $e->getLine() . "\n";
      return '';
    }
  }
}
import sanitizeHtml from 'sanitize-html';
import { decode } from 'html-entities';
import { IMessageQueuePub } from './MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { env } from 'node:process';
import { ILogger } from './Database/Interfaces/ILogger.js';
import { IDatabase } from './Database/Interfaces/IDatabase.js';

export class Utils {

  /**
   * Name of the service, used in Redis heartbeat updates.
   * @public
   * @type { string }
   */
  public static service_name: string;

  /**
   * Instance of the Logger class.
   * @public
   * @type { ILogger }
   */
  public static logger: ILogger;

  /**
   * PostgreSQL client class instance.
   * @public
   * @type { IDatabase }
   */
  public static dbconn: IDatabase;

  /**
   * Instance of the MQ Producer used for message publishing
   * sections of the code.
   * @public
   * @type { IMessageQueuePub }
   */
  public static mq_producer: IMessageQueuePub;

  /***
   * Regex used to try and extract image from item text.
   * Used when image is not provided explicitly for the feed item.
   * @public
   * @type { RegExp }
   */
  public static readonly image_extraction_regex: RegExp = /<img src=["\']([^"\']+)["\'][^>]*/gm;

  /**
   * Max words to keep when generating an excerpt (summary) from RSS items
   * that do not have it set.
   * @public
   * @type { number }
   */
  public static readonly max_summary_words: number = 150;

  /**
   * Temporary cached feed urls to IDs.
   *
   * @public
   * @type { Object }
   */
  public static feed_url_to_id: Object = {};

  /**
   * Retrieves first image from the HTML string given.
   *
   * @param { string } html The HTML markup from which we want to extract the image.
   * @public
   * @return { string } Returns URL for the first image in the given HTML markup
   *                    or an empty string if no image was found.
   */
  public static get_first_img_from_html( html: string ): string {
    let
      m: RegExpExecArray | null,
      img: string = '';

    while ( (m = Utils.image_extraction_regex.exec( html )) !== null) {
      if ( img !== '' ) {
        break;
      }

      // this is necessary to avoid infinite loops with zero-width matches
      if ( m.index === Utils.image_extraction_regex.lastIndex) {
        Utils.image_extraction_regex.lastIndex++;
      }

      m.forEach((match, groupIndex) => {
        // only use the first match, even if multiple images are found,
        // since the first match is usually the main one
        if ( img === '' && groupIndex == 1 ) {
          img = match;
        }
      });
    }

    return img;
  }

  /**
   * Publishes link data via MQ Producer.
   *
   * @param { Object } link_data The link data to publish.
   * @param { string } trace_id  Trace ID for this link message received from MQ.
   * @public
   */
  public static async publish_new_link_data( link_data: Object, trace_id: string ): Promise<void> {
    // add service name to the link data message
    link_data[ 'service' ] = Utils.service_name;

    // publish new link message
    // no await - we're not returning anything here
    Utils.mq_producer.send( env.NEW_LINKS_CHANNEL_NAME, link_data, trace_id, link_data[ 'link' ] );
  }

  /**
   * Extracts and returns extension of a file or emty string if none was found.
   * @see https://stackoverflow.com/a/12900504/467164
   * @param fname
   * @public
   */
  public static get_file_extension( fname: string ): string {
    return fname.slice( ( Math.max( 0, fname.lastIndexOf( '.' ) ) || Infinity ) + 1 );
  }

  /**
   * Removes all HTML tags, extra spaces, new lines, tabs
   * and carriage-return characters from the input string.
   *
   * @param { string }  txt          The text to remove HTML tags from.
   * @param { boolean } keep_br_tags If true, new lines will be replaced by <br> tags which will be kept.
   *                                 Otherwise, all tags will be stripped.
   * @public
   * @return { string } Returns the cleared up string without tags and special characters.
   */
  public static untagize( txt: string, keep_br_tags: boolean = true ): string {
    if ( typeof( txt ) === 'undefined' ) {
      return '';
    }

    // trim the string
    txt = txt.trim();

    // if we're not keeping BR tags, let's replace all tabs and new line characters by a space
    if ( !keep_br_tags ) {
      txt = txt.replace( /[\n\r\t]/g, ' ' );
    } else {
      // we're keeping BR tags, just remove tab characters
      txt = txt.replace( /[\t]/g, ' ' ).replace( / {2,}/g, ' ' );
    }

    // decode any HTML entities back into their respective characters
    txt = decode( txt );

    // strip all HTML tags
    txt = sanitizeHtml( txt );

    // strip the string of all 2-and-more spaces
    txt = txt.replace( / {2,}/g, ' ' );

    // if we're keeping BR tags, convert new lines to BR tags here
    if ( keep_br_tags ) {
      txt = Utils.nl2br( txt, true );
    }

    return txt;
  }

  /**
   * Converts new lines into <br> tags.
   * @param { string }  str      The string in which we want to replace new lines.
   * @param { boolean } is_xhtml Determines which BR tags - HTML or XHTML ones - we'll use as a replacement.
   * @public
   */
  public static nl2br (str: string, is_xhtml: boolean): string {
    // http://kevin.vanzonneveld.net
    // +   original by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
    // +   improved by: Philip Peterson
    // +   improved by: Onno Marsman
    // +   improved by: Atli Þór
    // +   bugfixed by: Onno Marsman
    // +      input by: Brett Zamir (http://brett-zamir.me)
    // +   bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
    // +   improved by: Brett Zamir (http://brett-zamir.me)
    // +   improved by: Maximusya
    // *     example 1: nl2br('Kevin\nvan\nZonneveld');
    // *     returns 1: 'Kevin<br />\nvan<br />\nZonneveld'
    // *     example 2: nl2br("\nOne\nTwo\n\nThree\n", false);
    // *     returns 2: '<br>\nOne<br>\nTwo<br>\n<br>\nThree<br>\n'
    // *     example 3: nl2br("\nOne\nTwo\n\nThree\n", true);
    // *     returns 3: '<br />\nOne<br />\nTwo<br />\n<br />\nThree<br />\n'
    var breakTag = (is_xhtml || typeof is_xhtml === 'undefined') ? '<br ' + '/>' : '<br>'; // Adjust comment to avoid issue on phpjs.org display

    return (str + '').replace(/([^>\r\n]?)(\r\n|\n\r|\r|\n)/g, '$1' + breakTag + '$2');
  }

  /**
   * Generates a short summary of the given long text.
   *
   * @param { string } txt The text to generate summary for.
   * @return { string } Returns the shortened summary text.
   */
  public static generate_summary( txt: string, max_words: number = 0 ): string {
    return Utils.untagize( txt )
      .split(" ")
      .slice( 0, ( max_words > 0 ? max_words : Utils.max_summary_words ) )
      .join(" ");
  }

  /**
   * Checks whether we have feed_id -> feed_url mapping present
   * for the given feed and caches it if we don't. Also creates
   * a cleanup task to remove the cached value after 45 minutes
   * of feed inactivity.
   *
   * @param { string } feed_url The feed URL to check for ID mapping existance.
   * @public
   *
   * @return { Promise<boolean> } Returns true if the feed was successfully cached,
   *                              false otherwise.
   */
  public static async checkAndCacheFeedURL( feed_url: string ): Promise<boolean> {
    let ret: boolean = true;

    if ( !Utils.feed_url_to_id[ feed_url ] ) {
      try {
        const res_id: bigint = await Utils.dbconn.get_feed_id_from_url( feed_url );
        if ( res_id ) {
          Utils.feed_url_to_id[ feed_url ] = res_id;
        } else {
          Utils.feed_url_to_id[ feed_url ] = 0;

          // we couldn't get link ID for this feed, log error
          // no await - we're returning boolean that's manually set below
          Utils.logger.log_msg( 'Could not find feed in database: ' + feed_url, 'ERR_LINK_WRITER_NO_RSS_FEED_RECORD' );
          ret = false;
        }

        // clean up this feed's ID cache after 45 minutes, so we clear up some memory
        // if the feed is not being updated that frequently
        setTimeout( () => {
          delete Utils.feed_url_to_id[ feed_url ];
        }, 1000 * 60 * 45 );
      } catch ( err ) {
        // no await - we're returning boolean that's manually set below
        Utils.logger.log_msg( 'Database error trying to get feed info from DB: ' + JSON.stringify( err ), 'ERR_LINK_WRITER_DB_READ_ERROR' );
        ret = false;
      }
    }

    return ret;
  }
}
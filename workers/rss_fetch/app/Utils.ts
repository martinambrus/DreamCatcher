import striptags from "striptags";
import { decode } from 'html-entities';
import { KafkaProducer} from './KafkaProducer.js';

export class Utils {

  /**
   * Name of the service, used in Redis heartbeat updates.
   * @private
   * @type { string }
   */
  public static service_name: string;

  /**
   * Instance of the KafkaProducer used for message publishing
   * sections of the code.
   * @private
   * @type { KafkaProducer }
   */
  public static kafka_producer: KafkaProducer;

  /***
   * Regex used to try and extract image from item text.
   * Used when image is not provided explicitly for the feed item.
   * @private
   * @type { RegExp }
   */
  public static readonly image_extraction_regex: RegExp = /<img src=["\']([^"\']+)["\'][^>]*/gm;

  /**
   * Max words to keep when generating an excerpt (summary) from RSS items
   * that do not have it set.
   * @private
   * @type { number }
   */
  public static readonly max_summary_words: number = 150;

  /**
   * Retrieves first image from the HTML string given.
   *
   * @param { string } html The HTML markup from which we want to extract the image.
   * @private
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
   * Publishes link data via Kafka Producer.
   *
   * @param { Object } link_data The link data to publish.
   * @private
   */
  public static async publish_new_link_data( link_data: Object ): Promise<void> {
    // add service name to the link data message
    link_data[ 'service' ] = Utils.service_name;

    // publish new link message
    await Utils.kafka_producer.pub_item( link_data );
  }

  /**
   * Extracts and returns extension of a file or emty string if none was found.
   * @see https://stackoverflow.com/a/12900504/467164
   * @param fname
   * @private
   */
  public static get_file_extension( fname: string ): string {
    return fname.slice( ( Math.max( 0, fname.lastIndexOf( '.' ) ) || Infinity ) + 1 );
  }

  /**
   * Removes all HTML tags, extra spaces, new lines, tabs
   * and carriage-return characters from the input string.
   * @param { string }txt
   * @private
   * @return { string } Returns the cleared up string without tags and special characters.
   */
  public static untagize( txt: string ): string {
    if ( typeof( txt ) == 'undefined' ) {
      return '';
    }

    return Utils.nl2br( decode( striptags( txt.trim() ) ), true );
  }

  /**
   * Converts new lines into <br> tags.
   * @param { string }  str      The string in which we want to replace new lines.
   * @param { boolean } is_xhtml Determines which BR tags - HTML or XHTML ones - we'll use as a replacement.
   * @private
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

}
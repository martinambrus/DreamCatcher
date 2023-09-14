import striptags from "striptags";
import { decode } from 'html-entities';

export class Utils {

  /**
   * Removes all HTML tags, extra spaces, new lines, tabs
   * and carriage-return characters from the input string.
   * @param { string }txt
   * @private
   * @return { string } Returns the cleared up string without tags and special characters.
   */
  public static untagize( txt: string ): string {
    if ( typeof( txt ) === 'undefined' ) {
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

}
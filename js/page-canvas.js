/**
 * Javascript library for viewing and interactive editing of Page XMLs.
 *
 * @version $Version: 2017.10.06$
 * @author Mauricio Villegas <mauricio_ville@yahoo.com>
 * @copyright Copyright(c) 2015-present, Mauricio Villegas <mauricio_ville@yahoo.com>
 * @license MIT License
 */

// @todo View word, line and region reading order, and possibility to modify it
// @todo On word break, move one part to a different line?
// @todo Round coords and/or remove non-page-xsd elements on export
// @todo Schema validation
// @todo Make dragpoints invisible/transparent when dragging? Also the poly* lines?
// @todo Config option to enable/disable standardizations
// @todo Seems slow to select TextLines and TextRegions
// @todo What to do with the possibility that some Page element id is used elsewhere in the DOM?
// @todo Regions only allowed to be inside PrintSpace, if present.
// @todo When creating tables require minimum size of cols*pointsMinLength x rows*pointsMinLength

(function( global ) {
  'use strict';

  var
  version = '$Version: 2017.10.06$'.replace(/^\$Version. (.*)\$/,'$1');

  /// Set PageCanvas global object ///
  if ( ! global.PageCanvas )
    global.PageCanvas = PageCanvas;

  /// Inherit from SvgCanvas ///
  global.PageCanvas.prototype = Object.create( global.SvgCanvas.prototype );
  global.PageCanvas.prototype.constructor = PageCanvas;

  /**
   * Constructor for PageCanvas instances.
   *
   * @param {string} pageContainer  ID of the container element.
   * @param {object} config         Object specifying configuration options.
   * @class
   */
  function PageCanvas( pageContainer, config ) {
    /// Private variables ///
    var
    self = this,
    versions,
    pageSvg,
    canvasSize,
    images,
    imagesLoadReady,
    fontSize,
    hasXmlDecl,
    importSvgXsltHref = [],
    exportSvgXsltHref = [],
    xslt_import = [],
    xslt_export = [],
    readDirs = {
      'ltr': 'left-to-right',
      'rtl': 'right-to-left',
      'ttb': 'top-to-bottom' };

    /// Parent constructor ///
    global.SvgCanvas.call( this, pageContainer, {} );
    versions = self.getVersion();
    versions.PageCanvas = version;

    /// Get container element ///
    pageContainer = document.getElementById(pageContainer);

    /// Configurable options additional or overriding the ones from SvgCanvas ///
    self.cfg.importSvgXsltHref = null;
    self.cfg.exportSvgXsltHref = null;
    self.cfg.ajaxLoadTimestamp = false;
    self.cfg.imageLoader = [];
    self.cfg.baselinesInRegs = false;
    self.cfg.baselineMaxPoints = 0;
    self.cfg.baselineMaxAngleDiff = Math.PI/2;
    self.cfg.baselineFirstAngleRange = null;
    self.cfg.coordsMaxPoints = 0;
    self.cfg.pointsMinLength = 5;
    self.cfg.polyrectHeight = 40;
    self.cfg.polyrectOffset = 0.25;
    self.cfg.readingDirection = 'ltr';
    self.cfg.textOrientation = 0;
    self.cfg.tableSize = [ 3, 3 ];
    self.cfg.onPropertyChange = [];
    self.cfg.onToggleProduction = [];
    self.cfg.onFinishCoords = [];
    self.cfg.onFinishBaseline = [];
    self.cfg.onFinishTable = [];
    self.cfg.newElemID = null;
    self.cfg.onImageLoad = [];
    self.cfg.onSetEditText.push( function ( elem ) {
        elem = $(elem).closest('g');
        self.cfg.multilineText = elem.hasClass('TextRegion') ? true : false ;
      } );
    self.cfg.onUnselect.push( handleBrokenWordUnselect );
    self.cfg.onSelect.push( handleBrokenWordSelect );
    self.cfg.onDelete.push( handleBrokenWordDelete );
    self.cfg.onDrop.push( sortOnDrop );
    self.cfg.delSelector = function ( elem ) {
        elem = $(elem).closest('g');
        if ( elem.length === 0 )
          elem = false;
        else if ( elem.hasClass('TableCell') )
          elem = elem.find('.TextLine');
        else if ( elem.hasClass('TableRegion') )
          elem = $(self.util.svgRoot).find('.TextRegion[id^="'+elem.attr('id')+'_"]').add(elem);
        return elem;
      };
    self.cfg.delRowColConfirm = function () { return false; };
    self.cfg.onRemovePolyPoint.push( function( elem, point ) {
        if ( ! $(elem).is('.Baseline') || ! $(elem).parent().is('.TextLine[polyrect],.TextLine[polystripe]') )
          return;
        var coords = $(elem).siblings('.Coords')[0].points;
        coords.removeItem(coords.numberOfItems-point-1);
        coords.removeItem(point);
      } );
    self.cfg.onAddPolyPoint.push( function( elem, point ) {
        if ( ! $(elem).is('.Baseline') || ! $(elem).parent().is('.TextLine[polyrect],.TextLine[polystripe]') )
          return;
        if ( $(elem).parent().is('.TextLine[polyrect]') ) {
          var polyrect = $(elem).parent().attr('polyrect').split(' ').map(parseFloat);
          setPolyrect( elem, polyrect[0], polyrect[1] );
        }
        else {
          var polystripe = $(elem).parent().attr('polystripe').split(' ').map(parseFloat);
          setPolystripe( elem, polystripe[0], polystripe[1] );
        }
      } );

    /// Define jQuery destroyed special event ///
    (function($){
      $.event.special.destroyed = {
        remove: function(o) {
          if (o.handler && o.type !== 'destroyed') {
            o.handler.apply(this,arguments);
          }
        }
      };
    })(jQuery);

    /// Loader for PDF using pdf.js ///
    self.cfg.imageLoader.push( function ( image, onLoad ) {
        if ( typeof PDFJS === 'undefined' )
          return false;
        if ( typeof image === 'string' )
          return /\.pdf(\[[0-9]+]|)$/i.test(image);

        var
        url = image.attr('data-rhref').replace(/\[[0-9]+]$/,''),
        pageNum = /]$/.test(image.attr('data-rhref')) ? parseInt(image.attr('data-rhref').replace(/.*\[([0-9]+)]$/,'$1')) : 1,
        imgWidth = parseInt(image.attr('width')),
        imgHeight = parseInt(image.attr('height'));

        PDFJS.getDocument(url)
          .then( function( pdf ) {
            if ( pageNum < 1 || pageNum > pdf.numPages )
              self.throwError( 'Unexpected page number: '+pageNum );

            pdf.getPage(pageNum)
              .then( function( page ) {
                var viewport = page.getViewport(1.0);
                if ( Math.abs( imgWidth/imgHeight - viewport.width/viewport.height ) > 1e-2 )
                  self.warning( 'aspect ratio differs between pdf page and XML: '+viewport.width+'/'+viewport.height+' vs. '+imgWidth+'/'+imgHeight );

                viewport = page.getViewport( imgWidth/viewport.width );

                var
                canvas = $('<canvas/>')[0],
                context = canvas.getContext('2d');
                canvas.height = imgHeight;
                canvas.width = imgWidth;

                page.render({ canvasContext: context, viewport: viewport })
                  .then( function () {
                    canvas.toBlob( function(blob) {
                      var url = URL.createObjectURL(blob);
                      image.attr( 'data-rhref', url );
                      //image.on('load', function() { URL.revokeObjectURL(url); });
                      image.on('destroyed', function() { URL.revokeObjectURL(url); });
                      onLoad(image);
                    } );
                  },
                  function ( err ) {
                    self.throwError( 'problems rendering pdf: '+err );
                  } );
              },
              function ( err ) {
                self.throwError( 'problems getting pdf page: '+err );
              } );
          },
          function ( err ) {
            self.throwError( 'problems getting pdf: '+err );
          } );
      } );

    /// Loader for TIFF using tiff.js ///
    self.cfg.imageLoader.push( function ( image, onLoad ) {
        if ( typeof Tiff === 'undefined' )
          return false;
        if ( typeof image === 'string' )
          return /\.tif{1,2}(\[[0-9]+]|)$/i.test(image);

        var
        url = image.attr('data-rhref').replace(/\[[0-9]+]$/,''),
        pageNum = /]$/.test(image.attr('data-rhref')) ? parseInt(image.attr('data-rhref').replace(/.*\[([0-9]+)]$/,'$1')) : 1;

        Tiff.initialize({TOTAL_MEMORY: 16777216 * 10});
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function (e) {
          var buffer = xhr.response;
          var tiff = new Tiff({buffer: buffer});
          if ( pageNum < 1 || pageNum > tiff.countDirectory() )
            self.throwError( 'Unexpected page number: '+pageNum );
          tiff.setDirectory(pageNum-1);
          var canvas = tiff.toCanvas();
          canvas.toBlob( function(blob) {
            var url = URL.createObjectURL(blob);
            image.attr( 'data-rhref', url );
            //image.on('load', function() { URL.revokeObjectURL(url); });
            image.on('destroyed', function() { URL.revokeObjectURL(url); });
            onLoad(image);
          } );
        };
        xhr.send();
      } );

    /// Utility variables and functions ///
    self.util.setPolyrect = setPolyrect;

    /// Apply input configuration ///
    self.setConfig( config );

    /**
     * Returns the version of the library and its dependencies.
     */
    self.getVersion = function () {
      return $.extend(true, {}, versions);
    };

    /// Preload XSLT ///
    loadXslt(true);

    /**
     * Resets XSLTs for converting to and from Page SVG.
     */
    self.setXslt = function ( importSvgXsltHref, exportSvgXsltHref ) {
      xslt_import = [];
      xslt_export = [];
      self.cfg.importSvgXsltHref = importSvgXsltHref;
      self.cfg.exportSvgXsltHref = exportSvgXsltHref;
      loadXslt(true);
    };

    /// Functions for comparing arrays ///
    function isElemString(e) { return typeof e === 'string'; }
    function returnElem(e){ return e; }
    function arraysEqual( arr1, arr2 ) {
      if ( arr1.length !== arr2.length )
        return false;
      for ( var i=arr1.length-1; i>=0; i-- )
        if ( arr1[i] !== arr2[i] )
          return false;
      return true;
    }

    /**
     * Loads the XSLT for converting Page XML to SVG.
     */
    function loadXslt( async ) {
      var href, n;

      /// Load import XSLT(s) ///
      if ( self.cfg.importSvgXsltHref &&
           ( ! arraysEqual( importSvgXsltHref, href=[].concat(self.cfg.importSvgXsltHref) ) ||
             ! xslt_import.every(returnElem) ) ) {

        if ( ! href.every(isElemString) )
          self.throwError( 'Expected importSvgXsltHref to be a string or an array of strings' );

        importSvgXsltHref = href;
        xslt_import = Array.apply(null, Array(importSvgXsltHref.length));

        for ( n=0; n<xslt_import.length; n++ ) // jshint -W083
          (function(idx) {
            $.ajax({ url: importSvgXsltHref[idx], async: async, dataType: 'xml' })
              .fail( function () { self.throwError( 'Failed to retrive '+importSvgXsltHref[idx] ); } )
              .done( function ( data ) {
                  xslt_import[idx] = new XSLTProcessor();
                  xslt_import[idx].importStylesheet( data );
                } );
          })(n);
      }

      /// Load export XSLT(s) ///
      if ( self.cfg.exportSvgXsltHref &&
           ( ! arraysEqual( exportSvgXsltHref, href=[].concat(self.cfg.exportSvgXsltHref) ) ||
             ! xslt_export.every(returnElem) ) ) {

        if ( ! href.every(isElemString) )
          self.throwError( 'Expected exportSvgXsltHref to be a string or an array of strings' );

        exportSvgXsltHref = href;
        xslt_export = Array.apply(null, Array(exportSvgXsltHref.length));

        for ( n=0; n<xslt_export.length; n++ ) // jshint -W083
          (function(idx) {
            $.ajax({ url: exportSvgXsltHref[idx], async: async, dataType: 'xml' })
              .fail( function () { self.throwError( 'Failed to retrive '+exportSvgXsltHref[idx] ); } )
              .done( function ( data ) {
                  xslt_export[idx] = new XSLTProcessor();
                  xslt_export[idx].importStylesheet( data );
                } );
          })(n);
      }
    }

    /**
     * Creates an empty Page XML as a string.
     */
    self.newXmlPage = function ( creator, image, width, height ) {
      var
      date = (new Date()).toISOString().replace(/\.[0-9]*/,''),
      xml =  '<?xml version="1.0" encoding="utf-8"?>\n';
      xml += '<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2013-07-15">\n';
      xml += '  <Metadata>\n';
      xml += '    <Creator>'+creator+'</Creator>\n';
      xml += '    <Created>'+date+'</Created>\n';
      xml += '    <LastChange>'+date+'</LastChange>\n';
      xml += '  </Metadata>\n';
      xml += '  <Page imageFilename="'+image+'" imageHeight="'+height+'" imageWidth="'+width+'"/>\n';
      xml += '</PcGts>\n';
      return xml;
    };

    /**
     * Gets the current state of the Page document.
     */
    self.getXmlPage = function () {
      var pageSvg = self.getSvgClone();

      $(pageSvg).find('LastChange').html((new Date()).toISOString().replace(/\.[0-9]*/,''));

      /// Remove non-Page XML content ///
      $(pageSvg).find('.wordpart').removeClass('wordpart');
      $(pageSvg).find('.not-dropzone').removeClass('not-dropzone');
      $(pageSvg).find('.TableCell').removeClass('TableCell').removeAttr('tableid');
      $(pageSvg).find('[polyrect]').removeAttr('polyrect');
      $(pageSvg).find('[polystripe]').removeAttr('polystripe');
      $(pageSvg).find('text:not(.TextEquiv)').remove();
      $(pageSvg).find('text').removeAttr('transform clip-path');
      $(pageSvg).find('.Background').remove();
      $(pageSvg).find('.Property[value=""]').removeAttr('value');
      $(pageSvg).find('.RelationShow').remove();

      /// Remove offset from coordinates of pages ///
      var pages = $(pageSvg).find('.Page');
      for ( var m=1; m<pages.length; m++ ) { // jshint -W083
        var yOffset = parseFloat(pages.eq(m).attr('y-offset'));
        pages.eq(m).find('polygon, polyline').each( function () {
            var n, points=this.points;
            for ( n=points.numberOfItems-1; n>=0; n-- )
              points.getItem(n).y -= yOffset;
          } );
      }

      /// Add Coords to lines without ///
      $(pageSvg).find('.TextLine:not(:has(>.Coords))').each( function () {
          $(document.createElementNS(self.util.sns,'polygon'))
            .attr( 'points', '0,0 0,0' )
            .addClass('Coords')
            .prependTo(this);
        } );

      /// Set protected attribute ///
      $(pageSvg).find('.protected').each( function () {
          $(this).attr('protected','').removeClass('protected');
        } );

      var pageDoc = pageSvg;
      for ( var n=0; n<xslt_export.length; n++ )
        pageDoc = xslt_export[n].transformToFragment( pageDoc, document );

      return ( hasXmlDecl ? '<?xml version="1.0" encoding="utf-8"?>\n' : '' ) +
        (new XMLSerializer()).serializeToString(pageDoc) + '\n';
    };

    /**
     * Initializes the SVG canvas using a given Page XML source.
     *
     * @param {object}  pageDoc         Object representing a Page XML document.
     */
    self.loadXmlPage = function ( pageDoc, pagePath ) {

      /// Retrieve XML if not provided ///
      if ( typeof pageDoc === 'undefined' ) {
        var url = pagePath +
          ( self.cfg.ajaxLoadTimestamp ?
            '?t=' + (new Date()).toISOString().replace(/\.[0-9]*/,'') : '' );
        $.ajax({ url: url, dataType: 'xml' })
          .fail( function () { self.throwError( 'ajax request failed: ' + url ); } )
          .done( function ( data, textStatus, jqXHR ) {
            if ( ! data )
              return self.throwError( 'Received empty response for url='+url);
            self.loadXmlPage(data,pagePath); } );
        return;
      }

      hasXmlDecl = typeof pageDoc === 'string' && pageDoc.substr(0,5) === '<?xml' ? true : false ;

      if ( typeof pageDoc === 'string' )
        try { pageDoc = $.parseXML( pageDoc ); } catch(e) { self.throwError(e); }

      /// Apply XSLT to get Page SVG ///
      loadXslt(false);
      pageSvg = pageDoc;
      for ( var x=0; x<xslt_import.length; x++ )
        pageSvg = xslt_import[x].transformToFragment( pageSvg, document );

      /// Check that it is in fact a Page SVG ///
      if ( $(pageSvg).find('> svg > .Page').length === 0 )
        return self.throwError( 'Expected as input a Page SVG document'+( pagePath ? (' ('+pagePath+')') : '' ) );

      /// Get images and info ///
      imagesLoadReady = 0;
      images = $(pageSvg).find('.PageImage');
      canvasSize = { W: parseInt(images.first().attr('width')), H: parseInt(images.first().attr('height')) };
      //self.util.imgBase = images.first().attr('data-href').replace(/.*[/\\]/,'').replace(/\.[^.]+$/,'');

      /// Remove dummy Coords ///
      $(pageSvg).find('.TextLine > .Coords[points="0,0 0,0"]').remove();

      /// Standardize quadrilaterals and polyrects ///
      var numpolyrect = 0, height = 0, offset = 0;
      $(pageSvg).find('.TextLine > .Coords').each( function () {
          self.util.standardizeClockwise(this);
          var polystripe = isPolystripe(this);
          if ( polystripe ) {
            height += polystripe[0];
            offset += polystripe[1];
            numpolyrect++;
          }
          var polyrect = polystripe ? standardizePolyrect(this,true) : false;
          if ( polyrect ) {
            height += polyrect[0];
            offset += polyrect[1];
            numpolyrect++;
          }
          else if ( ! polystripe )
            self.util.standardizeQuad(this,true);
        } );
      if ( numpolyrect > 0 ) {
        self.cfg.polyrectHeight = height / numpolyrect;
        //self.cfg.polyrectOffset = offset / numpolyrect;
        self.cfg.polyrectOffset = 0.25;
      }
      else {
        self.cfg.polyrectHeight = 0.025 * Math.min( canvasSize.H, canvasSize.W );
        self.cfg.polyrectOffset = 0.25;
      }

      /// Mark table cells ///
      $(pageSvg).find('.TableRegion').each( function () {
          $(pageSvg).find('.TextRegion[id^="'+this.id+'_"]')
            .addClass('TableCell')
            .attr('tableid',this.id);
        } );

      /// Set protected class ///
      $(pageSvg).find('[protected]').each( function () {
          $(this).addClass('protected').removeAttr('protected');
        } );

      /// Loop through images ///
      var
      pageGap = canvasSize.H*0.01,
      yOffset = 0;
      for ( var i=0; i<images.length; i++ ) { // jshint -W083
        var
        image = images.eq(i),
        pageWidth = parseInt(image.attr('width')),
        pageHeight = parseInt(image.attr('height'));

        image.attr( 'data-rhref', image.attr('data-href') );

        if ( i > 0 ) {
          image.parent()
            .attr( 'y-offset', yOffset )
            .find('polygon, polyline').each( function () {
              var n, points=this.points;
              for ( n=points.numberOfItems-1; n>=0; n-- )
                points.getItem(n).y += yOffset;
            } );
          image.attr( 'y', parseFloat(image.attr('y'))+yOffset );
          canvasSize.W = pageWidth > canvasSize.W ? pageWidth : canvasSize.W;
          canvasSize.H += pageHeight+pageGap;
        }

        /// Add a white background under the image ///
        $(document.createElementNS(self.util.sns,'rect'))
          .attr( 'class', 'Background' )
          .attr( 'x', -0.5 )
          .attr( 'y', -0.5+yOffset )
          .attr( 'width', image.attr('width') )
          .attr( 'height', image.attr('height') )
          .css( 'fill', 'white' )
          .css( 'stroke', 'black' )
          .insertBefore(image);

        yOffset += pageHeight+pageGap;

        /// Check whether image is remote ///
        var
        hrefImg = image.attr('data-rhref'),
        remoteImg = /^https{0,1}:\/\//.test(hrefImg);

        /// Update image href if relative and page path given ///
        if ( ! remoteImg ) {
          if ( pagePath && (
                 hrefImg[0] !== '/' ||
                 pagePath.substr(1,2) === ':\\' ) ) {
            var
            delim = pagePath.substr(1,2) === ':\\' ? '\\' : '/',
            pageDir = pagePath.replace(/[/\\][^/\\]+$/,'');
            image.attr( 'data-rhref', pageDir+delim+hrefImg );
          }
          else if( pagePath &&
                   pagePath.match(/^file:\/\//) &&
                   hrefImg[0] === '/' ) {
            image.attr( 'data-rhref', 'file://'+hrefImg );
          }
        }

        /// Special image loaders ///
        var m;
        for ( m=self.cfg.imageLoader.length-1; m>=0; m-- )
          if ( self.cfg.imageLoader[m](image.attr('data-rhref')) ) {
            self.cfg.imageLoader[m](image,finishLoadXmlPage);
            break;
          }

        if ( m < 0 )
          finishLoadXmlPage(image);
      }
    };

    /**
     * Finishes the loading of the Page XML.
     */
    //function finishLoadXmlPage() {
    function finishLoadXmlPage( image ) {
      imagesLoadReady++;
      image.attr( 'xlink:href', image.attr('data-rhref') );
      image.removeAttr('data-rhref');

      /// Warn if image not loaded ///
      image.on('error', function () {
          console.log( 'warning: failed to load image: '+image.attr('xlink:href') );
        } );

      /// Warn if image size differs with respect to XML ///
      image.on('load', function ( event ) {
          var
          image = $(event.target),
          img = new Image();
          img.src = image.attr('xlink:href');
          if ( img.width <= 1 && img.height <= 1 )
            console.log('WARNING: unexpectedly image load called with image of size '+img.width+'x'+img.height);
          else {
            console.log('checking that image size agrees with the XML ...');
            if ( img.width != image.attr('width') || img.height != image.attr('height') )
              self.warning( 'image size differs between image and XML: '+img.width+'x'+img.height+' vs. '+image.attr('width')+'x'+image.attr('height') );
          }
        } );

      /// Image load callback functions ///
      for ( var n=0; n<self.cfg.onImageLoad.length; n++ )
        image.on('load', self.cfg.onImageLoad[n] );

      if ( imagesLoadReady < images.length )
        return;

      /// Load the Page SVG in the canvas ///
      self.loadXmlSvg(pageSvg);
      self.svgPanZoom( -1.5, -1.5, canvasSize.W+2, canvasSize.H+2 );
      self.positionText();

      /// Set currently selected mode ///
      self.mode.current();

      /// Scale font size ///
      fontSize = 0.010 * Math.min( canvasSize.H, canvasSize.W );
      scaleFont(1);

      /// Gamma filter ///
      var
      defs = $('#'+pageContainer.id+'_defs'),
      comps = [ 'feFuncR', 'feFuncG', 'feFuncB' ];

      var
      transf = $(document.createElementNS( self.util.sns, 'feComponentTransfer' ));
      for ( n = 0; n<comps.length; n++ )
        $(document.createElementNS(self.util.sns,comps[n]))
          .attr('type','gamma')
          .attr('amplitude','1')
          .attr('exponent',1)
          .appendTo(transf);
      $(document.createElementNS(self.util.sns,'filter'))
        .attr('id',pageContainer.id+'_gamma')
        .append(transf)
        .appendTo(defs);

      self.util.clearChangeHistory();
      self.util.pushChangeHistory('page load');
    }

    /// Bind keyboard sequence for gamma filter ///
    Mousetrap.bind( 'mod+g', function () {
        var gamma = parseInt( $('#'+pageContainer.id+'_gamma feComponentTransfer > *').first().attr('exponent') );
        gamma *= 2;
        if( gamma <= 8 )
          setGamma(gamma);
        else {
          setGamma(1);
          setGamma(false);
        }
        return false;
      } );
    self.util.setGamma = setGamma;
    function setGamma( gamma ) {
      var img = $(self.util.svgRoot).find('image');
      if ( ! gamma )
        img.removeAttr('filter');
      else {
        $('#'+pageContainer.id+'_gamma feComponentTransfer > *')
          .attr('exponent',gamma);
        img.attr('filter','url(#'+pageContainer.id+'_gamma)');
      }
    }

    /// Replace Coords points with fpgram coordinates ///
    self.util.fpgramToCoords = function () {
        var modified = 0;
        $('[fpgram]').each( function () {
            $(this)
              .attr('points',$(this).attr('fpgram'))
              .removeAttr('fpgram');
            modified++;
          } );
        if ( modified > 0 ) {
          console.log('replaced Coords points with fpgram for '+modified+' elements');
          self.util.registerChange('replaced Coords with fpgram');
        }
      };
    Mousetrap.bind( 'mod+shift+f', self.util.fpgramToCoords );

    /**
     * Breaks the selected word into two parts.
     */
    function breakSelectedWord() {
      var
      elem = $(self.util.svgRoot).find('.selected').closest('g'),
      isprotected = self.util.isReadOnly(elem);
      if ( elem.length === 0 || isprotected || elem.hasClass('wordpart') || ! elem.hasClass('Word') )
        return;

      self.mode.off();

      var
      text = self.cfg.textFormatter(elem.find('> .TextEquiv').html()),
      clone = elem.clone().attr( 'id', elem.attr('id')+'_part2' );
      elem.attr( 'id', elem.attr('id')+'_part1' );
      elem.find('> .TextEquiv').html( self.cfg.textParser(text+'\u00AD') );
      clone.find('> .TextEquiv').html( self.cfg.textParser('\u00AD'+text) );

      self.util.moveElem( clone[0], elem[0].getBBox().width, 0 );

      alert('WARNING: Breaking selected word. Its ids will be set to: "'+elem.attr('id')+'" and "'+clone.attr('id')+'". Both parts will have as text "'+text+'". Please update the text and positions as required.');

      self.util.unselectElem(elem);

      elem.after(clone);

      self.mode.current();
      self.util.selectElem(elem);

      self.util.registerChange('word break for '+elem.attr('id'));
    }
    self.util.breakSelectedWord = breakSelectedWord;
    //Mousetrap.bind( 'mod+b', function () { breakSelectedWord(); return false; } );

    /**
     * Adds a class 'wordpart' when selecting a broken word.
     */
    function handleBrokenWordSelect( elem ) {
      elem = $(elem).closest('g');
      if ( elem.length > 0 && elem.hasClass('Word') && elem.attr('id').match(/_part[12]$/) ) {
        elem.addClass('wordpart');
        var wpart = elem.attr('id').replace(/.*(_w[^_]+_part[12])$/,'$1');
        if ( wpart.match(/1$/) )
          wpart = wpart.replace(/1$/,'2');
        else
          wpart = wpart.replace(/2$/,'1');
        elem.closest('g.TextRegion')
          .find('g[id$="'+wpart+'"]')
          .addClass('wordpart');
      }
    }

    /**
     * Removes the class 'wordpart' in case broken word was unselected.
     */
    function handleBrokenWordUnselect() {
      $(self.util.svgRoot).find('.wordpart').removeClass('wordpart');
    }

    /**
     * On deletion of a part of a broken word, it updates the other part's id and text.
     */
    function handleBrokenWordDelete( elem ) {
      elem = $(elem).closest('g');
      if ( elem.length > 0 && elem.hasClass('Word') && elem.attr('id').match(/_part[12]$/) ) {
        var
        deltext = self.cfg.textFormatter(elem.find('> .TextEquiv').html()).replace(/\u00AD/g,''),
        wpart = elem.attr('id').replace(/.*(_w[^_]+_part[12])$/,'$1');
        if ( wpart.match(/1$/) )
          wpart = wpart.replace(/1$/,'2');
        else
          wpart = wpart.replace(/2$/,'1');
        elem = elem.closest('g.TextRegion').find('g[id$="'+wpart+'"].wordpart');
        var
        keeptext = self.cfg.textFormatter(elem.find('> .TextEquiv').html()).replace(/\u00AD/g,''),
        newtext = wpart.match(/1$/) ? keeptext+deltext : deltext+keeptext,
        newid = elem.attr('id').replace(/_part[12]$/,'');
        alert('WARNING: Due to part of broken word deletion, the other part will be updated.\nid: '+elem.attr('id')+' => '+newid+'\ntext: "'+keeptext+'" => "'+newtext+'"');
        elem.attr( 'id', newid );
        elem.find('> .TextEquiv').html( self.cfg.textParser(newtext) );
      }
    }

    /**
     * Inserts a word or a line in an appropriate position with respect to its
     * siblings, considering the elements x (for words) or y (for lines)
     * center coordinates. Also updates the line part of the word id.
     */
    function sortOnDrop( elem ) {
      elem = $(elem);
      var
      sibl = elem.siblings('g'),
      isword = elem.hasClass('Word'),
      isline = elem.hasClass('TextLine');

      if ( isword ) {
        var lineid = elem.closest('.TextLine').attr('id');
        if ( elem.attr('id').includes('_w') &&
             elem.attr('id').replace(/_w.+/,'') !== lineid ) {
          elem.attr( 'id', lineid+'_w'+elem.attr('id').replace(/.+_w/,'') );
          self.util.selectElem(elem[0],true);
        }
      }

      if ( sibl.length === 0 || ! ( isword || isline ) )
        return;

      var
      prevelem = null,
      prevdist = 1e9,
      nextelem = null,
      nextdist = 1e9,
      rect = elem[0].getBBox(),
      elempos = isword ? rect.x + 0.5*rect.width : rect.y + 0.5*rect.height;

      sibl.each( function () {
          var
          rect = this.getBBox(),
          dist = ( isword ? rect.x + 0.5*rect.width : rect.y + 0.5*rect.height ) - elempos;
          if ( dist >= 0 && dist < nextdist ) {
            nextelem = this;
            nextdist = dist;
          }
          if ( dist < 0 && -dist < prevdist ) {
            prevelem = this;
            prevdist = -dist;
          }
        } );

      if ( ! prevelem )
        elem.insertBefore(nextelem);
      else
        elem.insertAfter(prevelem);
    }

    /**
     * Changes the scale of the text font size.
     */
    function scaleFont( fact ) {
      fontSize *= fact;
      var cssrule = '#'+self.cfg.stylesId+'{ #'+pageContainer.id+' .TextEquiv }';
      $.stylesheet(cssrule).css( 'font-size', fontSize+'px' );
    }
    Mousetrap.bind( 'mod+pagedown', function () { scaleFont(0.9); return false; } );
    Mousetrap.bind( 'mod+pageup', function () { scaleFont(1/0.9); return false; } );

    /**
     * Toggles production of the selected element's group.
     */
    function toggleProduction( val ) {
      var
      sel = $(self.util.svgRoot).find('.selected').first().closest('g');
      if ( sel.length === 0 || self.util.isReadOnly(sel) )
        return true;

      if ( sel.attr('production') === val )
        sel.removeAttr('production');
      else
        sel.attr('production',val);

      for ( var n=0; n<self.cfg.onToggleProduction.length; n++ )
        self.cfg.onToggleProduction[n](sel);

      self.util.registerChange('toggled production '+val+' of '+sel.attr('id'));

      return false;
    }
    self.util.toggleProduction = toggleProduction;
    //Mousetrap.bind( 'mod+.', function () { return toggleProduction( 'printed' ); } );
    //Mousetrap.bind( 'mod+,', function () { return toggleProduction( 'handwritten' ); } );

    /**
     * Appends a newly created SVG text to an element and positions it.
     */
    function createSvgText( elem, selector ) {
      var textElem = $(elem)
        .append( $(document.createElementNS(self.util.sns,'text')).addClass('TextEquiv') )
        .find(selector);
      positionTextNode( textElem[0] );
      return textElem;
    }

    /**
     * Sets the TextEquiv of an element, creating the svg text if it does not exist.
     */
    function setTextEquiv( text, elem, selector ) {
      elem = $(elem).closest('g');
      if ( self.util.isReadOnly(elem) || ! elem.is('.TextRegion, .TextLine, .Word, .Glyph') )
        return true;

      if ( typeof selector === 'undefined' )
        selector = '> .TextEquiv';

      var
      prevText = '',
      textElem = elem.find(selector).first();
      if ( textElem.length === 0 )
        textElem = createSvgText(elem,selector);
      else
        prevText = self.cfg.textFormatter(textElem.html());

      if ( self.cfg.textFormatter(text) !== prevText ) {
        textElem.html( self.cfg.textParser(text) );
        self.util.registerChange('changed TextEquiv of '+elem[0].id);
      }

      return false;
    }
    self.util.setTextEquiv = setTextEquiv;

    /**
     * Gets the TextEquiv content.
     */
    function getTextEquiv( elem, selector ) {
      elem = $(elem).closest('g');
      if ( ! elem.is('.TextRegion, .TextLine, .Word, .Glyph') )
        return;

      if ( typeof selector === 'undefined' )
        selector = '> .TextEquiv';

      var textElem = elem.find(selector).first();
      if ( textElem.length > 0 )
        return pageCanvas.cfg.textFormatter(textElem.html());
    }
    self.util.getTextEquiv = getTextEquiv;

    /// Edit modes additional to the ones from SvgCanvas ///
    self.mode.lineBaselineCreate = editModeBaselineCreate;
    self.mode.tableCreate = editModeTableCreate;
    self.mode.tablePoints = editModeTablePoints;
    self.mode.addRelation = editModeAddRelation;
    self.mode.relationSelect  = function () { return self.mode.select( '.Relation' ); };
    self.mode.regionSelect    = function ( textedit ) {
      return textedit ?
        self.mode.text( '.TextRegion:not(.TableCell)', '> .TextEquiv', createSvgText ):
        self.mode.select( '.TextRegion:not(.TableCell)' ); };
    self.mode.lineSelect      = function ( textedit ) {
      return textedit ?
        self.mode.text( '.TextLine', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
        self.mode.select( '.TextLine', '.TextRegion > polygon' ); };
    self.mode.wordSelect      = function ( textedit ) {
      return textedit ?
        self.mode.text( '.Word', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
        self.mode.select( '.Word', '.TextRegion > polygon' ); };
    self.mode.glyphSelect     = function ( textedit ) {
      return textedit ?
        self.mode.text( '.Glyph', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
        self.mode.select( '.Glyph', '.TextRegion > polygon' ); };
    self.mode.cellSelect      = function ( textedit ) {
      return textedit ?
        self.mode.text( '.TableCell', '> .TextEquiv', createSvgText ):
        self.mode.select( '.TableCell' ); };
    self.mode.regionBaselines = function ( textedit ) {
      return textedit ?
        self.mode.textPoints( '.TextRegion', 'polyline', '> .TextEquiv', createSvgText ):
        self.mode.points( '.TextRegion', 'polyline' ); };
    self.mode.lineBaseline    = function ( textedit ) {
      return textedit ?
        self.mode.textPoints( '.TextLine', '> polyline', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
        self.mode.points( '.TextLine', '> polyline', '.TextRegion > polygon' ); };
    self.mode.regionCoords    = function ( textedit, restrict ) {
      return restrict ?
        ( textedit ?
            self.mode.textRect( '.TextRegion:not(.TableCell)', '> polygon', '> .TextEquiv', createSvgText ):
            self.mode.rect( '.TextRegion:not(.TableCell)', '> polygon' ) ):
        ( textedit ?
            self.mode.textPoints( '.TextRegion:not(.TableCell)', '> polygon', '> .TextEquiv', createSvgText ):
            self.mode.points( '.TextRegion:not(.TableCell)', '> polygon' ) ); };
    self.mode.lineCoords      = function ( textedit, restrict ) {
      return restrict ?
        ( textedit ?
            self.mode.textRect( '.TextLine', '> polygon', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
            self.mode.rect( '.TextLine', '> polygon', '.TextRegion > polygon' ) ):
        ( textedit ?
            self.mode.textPoints( '.TextLine', '> polygon', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
            self.mode.points( '.TextLine', '> polygon', '.TextRegion > polygon' ) ); };
    self.mode.wordCoords      = function ( textedit, restrict ) {
      return restrict ?
        ( textedit ?
            self.mode.textRect( '.Word', '> polygon', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
            self.mode.rect( '.Word', '> polygon', '.TextRegion > polygon' ) ):
        ( textedit ?
            self.mode.textPoints( '.Word', '> polygon', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
            self.mode.points( '.Word', '> polygon', '.TextRegion > polygon' ) ); };
    self.mode.glyphCoords     = function ( textedit, restrict ) {
      return restrict ?
        ( textedit ?
            self.mode.textRect( '.Glyph', '> polygon', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
            self.mode.rect( '.Glyph', '> polygon', '.TextRegion > polygon' ) ):
        ( textedit ?
            self.mode.textPoints( '.Glyph', '> polygon', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
            self.mode.points( '.Glyph', '> polygon', '.TextRegion > polygon' ) ); };
    self.mode.regionDrag      = function ( textedit ) {
      return textedit ?
        self.mode.textDrag( '.TextRegion:not(.TableCell)', undefined, '> .TextEquiv', createSvgText ):
        self.mode.drag( '.TextRegion:not(.TableCell)' ); };
    self.mode.lineDrag        = function ( textedit ) {
      return textedit ?
        self.mode.textDrag( '.TextLine', '.TextRegion', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
        self.mode.drag( '.TextLine', '.TextRegion', undefined, '.TextRegion > polygon' ); };
    self.mode.wordDrag        = function ( textedit ) {
      return textedit ?
        self.mode.textDrag( '.Word', '.TextLine', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
        self.mode.drag( '.Word', '.TextLine', undefined, '.TextRegion > polygon' ); };
    self.mode.glyphDrag       = function ( textedit ) {
      return textedit ?
        self.mode.textDrag( '.Glyph', '.Word', '> .TextEquiv', createSvgText, '.TextRegion > polygon' ):
        self.mode.drag( '.Glyph', '.Word', undefined, '.TextRegion > polygon' ); };
    self.mode.tableDrag       = function () {
      self.mode.drag( '.TableCell', undefined, function ( elem ) {
        var id = elem.attr('tableid');
        return $('.TableRegion[id="'+id+'"], .TextRegion[id^="'+id+'_"]');
      } ); };
    self.mode.regionCoordsCreate  = function ( restrict ) {
      return editModeCoordsCreate( restrict, '.TextRegion:not(.TableCell)', 'TextRegion', '.Page', 'Page', 'r' ); };
    self.mode.lineCoordsCreate    = function ( restrict ) {
      return editModeCoordsCreate( restrict, '.TextLine', 'TextLine', '.TextRegion', 'TextRegion', '*_l' ); };
    self.mode.wordCoordsCreate    = function ( restrict ) {
      return editModeCoordsCreate( restrict, '.Word', 'Word', '.TextLine', 'TextLine', '*_w' ); };
    self.mode.glyphCoordsCreate   = function ( restrict ) {
      return editModeCoordsCreate( restrict, '.Glyph', 'Glyph', '.Word', 'Word', '*_g' ); };

    /**
     * Positions a text node in the corresponding coordinates.
     *
     * @param {object}  textElem      The text element to position.
     */
    function positionTextNode( textElem ) {
      var lines = $(textElem).text().split('\n');
      //if ( lines.length > 1 ) {
        //console.log( "multiline text: "+$(textElem).text() );
        $(textElem).empty();
        //var tspan = document.createElementNS( self.util.sns, 'tspan' );
        //$(tspan).attr('x','0').text(lines[0]).appendTo(textElem);
        //for ( var n = 1; n < lines.length; n++ ) {
        for ( var n = 0; n < lines.length; n++ ) {
          var tspan = document.createElementNS( self.util.sns, 'tspan' );
          $(tspan).attr('x','0').attr('dy','1em').text(lines[n]).appendTo(textElem);
        }
      //}

      var
      baseline = $(textElem).siblings('.Baseline'),
      coords = baseline.length > 0 ? baseline : $(textElem).siblings('.Coords'),
      x = 1e9, y = 1e9;
      if ( coords.length > 0 ) {
        coords = coords[0];
        for ( var i = 0, len = coords.points.numberOfItems; i < len; i++ ) {
          var point = coords.points.getItem(i);
          x = point.x < x ? point.x : x ;
          y = point.y < y ? point.y : y ;
        }
        $(textElem).attr('transform','translate('+x+','+y+')');

        /// Add clip paths for the text ///
        if ( $(textElem).parent().hasClass('TextRegion') ) {
          var
          id = $(textElem).parent().attr('id'),
          defs = $('#'+pageContainer.id+'_defs'),
          use = document.createElementNS( self.util.sns, 'use' ),
          clip = document.createElementNS( self.util.sns, 'clipPath' );
          $(clip).attr( 'id', 'clip_'+id );

          $(textElem).siblings('polygon').attr( 'id', 'pts_'+id );
          use.setAttributeNS( self.util.xns, 'href', '#pts_'+id );
          use.setAttribute( 'transform', 'translate('+(-x)+','+(-y)+')' );
          clip.appendChild(use);

          $(defs).append(clip);
          $(textElem).attr( 'clip-path', 'url(#clip_'+id+')' );
        }
      }
    }

    /**
     * Positions all text nodes in the corresponding coordinates.
     */
    self.positionText = function positionText() {
      $(self.util.svgRoot).find('.TextEquiv').each( function () { positionTextNode(this); } );
    };

    /**
     * Removes a property.
     */
    function delProperty( key, sel ) {
      if ( typeof sel === 'undefined' )
        sel = '.selected';
      if ( typeof sel === 'string' )
        sel = $(self.util.svgRoot).find(sel);
      if ( typeof sel === 'object' && ! ( sel instanceof jQuery ) )
        sel = $(sel);
      sel = sel.closest('g');
      if ( sel.length !== 1 )
        return false;
      if ( self.util.isReadOnly(sel) )
        return false;

      var prop = sel.children('.Property[key="'+key+'"]');
      if( prop.length > 0 ) {
        prop.remove();

        for ( var n=0; n<self.cfg.onPropertyChange.length; n++ )
          self.cfg.onPropertyChange[n](sel);

        self.util.registerChange('property '+key+' removed from '+sel.attr('id'));
      }

      return true;
    }
    self.util.delProperty = delProperty;

    /**
     * Sets a property.
     */
    function setProperty( key, val, sel, uniq ) {
      if ( typeof sel === 'undefined' )
        sel = '.selected';
      if ( typeof sel === 'string' )
        sel = $(self.util.svgRoot).find(sel);
      if ( typeof sel === 'object' && ! ( sel instanceof jQuery ) )
        sel = $(sel);
      sel = sel.closest('g');
      if ( sel.length !== 1 )
        return null;
      if ( self.util.isReadOnly(sel) )
        return null;

      if ( typeof uniq === 'undefined' || uniq )
        sel.children('.Property[key="'+key+'"]').remove();
      var
      props = sel.children('.Property'),
      prop = $(document.createElementNS(self.util.sns,'g'))
        .addClass('Property')
        .attr('key',key);
      if ( typeof val !== 'undefined' )
        prop.attr('value',val);

      if ( props.length > 0 )
        prop.insertAfter( props.last() );
      else
        prop.prependTo(sel);

      for ( var n=0; n<self.cfg.onPropertyChange.length; n++ )
        self.cfg.onPropertyChange[n](sel);

      self.util.registerChange('property '+key+' set to '+sel.attr('id'));

      return prop;
    }
    self.util.setProperty = setProperty;

    /**
     * Toggles a property.
     */
    function toggleProperty( key, val, sel ) {
      if ( typeof sel === 'undefined' )
        sel = '.selected';
      if ( typeof sel === 'string' )
        sel = $(self.util.svgRoot).find(sel);
      if ( typeof sel === 'object' && ! ( sel instanceof jQuery ) )
        sel = $(sel);
      sel = sel.closest('g');
      if( sel.children('.Property[key="'+key+'"][value="'+val+'"]').length > 0 )
        delProperty( key, sel );
      else
        setProperty( key, val, sel );
      return false;
    }
    self.util.toggleProperty = toggleProperty;

    /**
     * True or false depending on whether the given property is set.
     */
    function hasProperty( key, val, sel ) {
      if ( typeof sel === 'undefined' )
        sel = '.selected';
      if ( typeof sel === 'string' )
        sel = $(self.util.svgRoot).find(sel);
      if ( typeof sel === 'object' && ! ( sel instanceof jQuery ) )
        sel = $(sel);
      sel = sel.closest('g');
      if ( typeof val === 'undefined' )
        return sel.children('.Property[key="'+key+'"]').length === 0 ? false : true;
      else
        return sel.children('.Property[key="'+key+'"][value="'+val+'"]').length === 0 ? false : true;
    }
    self.util.hasProperty = hasProperty;

    /**
     * Returns the property value.
     */
    function getProperty( key, sel ) {
      if ( typeof sel === 'undefined' )
        sel = '.selected';
      if ( typeof sel === 'string' )
        sel = $(self.util.svgRoot).find(sel).closest('g');
      if ( typeof sel === 'object' && ! ( sel instanceof jQuery ) )
        sel = $(sel);
      return sel.closest('g').children('.Property[key="'+key+'"]').attr('value');
    }
    self.util.getProperty = getProperty;


    /////////////////////////////
    /// Create elements modes ///
    /////////////////////////////


    /**
     * Creates a poly-stripe for a given baseline element.
     */
    function setPolystripe( baseline, height, offset ) {
      if ( ! $(baseline).hasClass('Baseline') ) {
        console.log('error: setPolystripe expects a Baseline element');
        return;
      }
      if ( height <= 0 || offset < 0 || offset > 0.5 )
        return;
      var n,
      coords = $(baseline).siblings('.Coords'),
      offup = height - offset*height,
      offdown = height - offup;
      if ( coords.length < 1 )
        coords = $(document.createElementNS(self.util.sns,'polygon'))
                   .addClass('Coords')
                   .insertBefore(baseline);
      else
        coords[0].points.clear();

      if ( baseline.parentElement.hasAttribute('polystripe') )
        $(baseline.parentElement).attr('polystripe',height+' '+offset);

      baseline = baseline.points;
      coords = coords[0].points;

      var l1p1, l1p2, l2p1, l2p2, base, uperp,
      point = Point2f();

      for ( n = 0; n < baseline.numberOfItems-1; n++ ) {
        base = Point2f(baseline.getItem(n+1)).subtract(baseline.getItem(n));
        uperp = Point2f(base.y,-base.x).unit();
        l2p1 = Point2f(baseline.getItem(n)).add(Point2f(uperp).hadamard(offup));
        l2p2 = Point2f(baseline.getItem(n+1)).add(Point2f(uperp).hadamard(offup));
        if ( n === 0 || ! intersection( l1p1, l1p2, l2p1, l2p2, point ) )
          coords.appendItem( l2p1.tosvg() );
        else
          coords.appendItem( point.tosvg() );
        l1p1 = l2p1;
        l1p2 = l2p2;
      }
      coords.appendItem( l2p2.tosvg() );

      for ( n = baseline.numberOfItems-1; n > 0; n-- ) {
        base = Point2f(baseline.getItem(n-1)).subtract(baseline.getItem(n));
        uperp = Point2f(base.y,-base.x).unit();
        l2p1 = Point2f(baseline.getItem(n)).add(Point2f(uperp).hadamard(offdown));
        l2p2 = Point2f(baseline.getItem(n-1)).add(Point2f(uperp).hadamard(offdown));
        if ( n === baseline.numberOfItems-1 || ! intersection( l1p1, l1p2, l2p1, l2p2, point ) )
          coords.appendItem( l2p1.tosvg() );
        else
          coords.appendItem( point.tosvg() );
        l1p1 = l2p1;
        l1p2 = l2p2;
      }
      coords.appendItem( l2p2.tosvg() );
    }
    self.util.setPolystripe = setPolystripe;

    /**
     * Converts polyrects to polystripes.
     */
    function polyrect2polystripe( elem ) {
      var g = $(elem).closest('g');
      if ( ! g.is('.TextLine') ) {
        console.log('polyrect2polystripe requires elements to be TextLines');
        return;
      }
      var
      coords = g.children('.Coords'),
      polystripeParams = isPolystripe(coords[0]),
      polyrectParams = isPolyrect(coords[0]);
      if ( polystripeParams ) {
        //console.log('TextLine with id='+g[0].id+' already a polystripe');
        return;
      }
      if ( ! polyrectParams ) {
        console.log(g[0]);
        var
        pts = coords[0].points,
        dim1 = Point2f(pts.getItem(0).x,pts.getItem(0).y).euc(Point2f(pts.getItem(1).x,pts.getItem(1).y)),
        dim2 = Point2f(pts.getItem(0).x,pts.getItem(0).y).euc(Point2f(pts.getItem(3).x,pts.getItem(3).y));
        if ( pts.length !== 4 ) {
          console.log('TextLine with id='+g[0].id+' not a polyrect nor a quadrilateral, unable to convert to polystripe');
          return;
        }
        setPolystripe(g.children('.Baseline')[0],dim1<dim2?dim1:dim2,0.25);
        console.log('WARNING: Converted non-polyrect TextLine with id='+g[0].id+' to polystripe');
        return;
      }
      setPolystripe(g.children('.Baseline')[0],polyrectParams[0],0.25);
    }
    self.util.polyrect2polystripe = polyrect2polystripe;

    /**
     * Checks whether Coords is a poly-stripe for its corresponding baseline.
     */
    function isPolystripe( coords ) {
      var baseline = $(coords).siblings('.Baseline');
      if ( ! $(coords).hasClass('Coords') ||
           baseline.length === 0 ||
           baseline[0].points.numberOfItems*2 !== coords.points.numberOfItems )
        return false;
      var n, m, prevbase, prevabove, prevbelow,
      eps = 1e-2;
      baseline = self.util.pointListToArray(baseline[0].points);
      coords = self.util.pointListToArray(coords.points);
      for ( n = 0; n < baseline.length; n++ ) {
        m = coords.length-1-n;

        /// Check points are colinear ///
        if ( ! pointInSegment( coords[n], coords[m], baseline[n] ) )
          return false;

        /// Check lines are parallel ///
        if ( n > 0 ) {
          prevbase = Point2f(baseline[n-1]).subtract(baseline[n]).unit();
          prevabove = Point2f(coords[n-1]).subtract(coords[n]).unit();
          prevbelow = Point2f(coords[m+1]).subtract(coords[m]).unit();
          if ( Math.abs(1-Math.abs(prevabove.dot(prevbase))) > eps ||
               Math.abs(1-Math.abs(prevbelow.dot(prevbase))) > eps )
            return false;
        }

        /// Check stripe extremes perpendicular to baseline ///
        if ( n === 0 || n === baseline.length-1 ) {
          var
          base = n > 0 ? prevbase : Point2f(baseline[1]).subtract(baseline[0]).unit(),
          extr = Point2f(coords[n]).subtract(coords[m]).unit();
          if ( base.dot(extr) > eps )
            return false;
        }
      }

      var
      offup = Point2f(baseline[0]).subtract(coords[0]).norm(),
      offdown = Point2f(baseline[0]).subtract(coords[coords.length-1]).norm();
      return [ offup+offdown, offdown/(offup+offdown) ];
    }
    self.util.isPolystripe = isPolystripe;

    /**
     * Checks whether Coords is a poly-rectangle for its corresponding baseline.
     */
    function isPolyrect( coords ) {
      var baseline = $(coords).siblings('.Baseline');
      if ( ! $(coords).hasClass('Coords') ||
           baseline.length === 0 ||
           baseline[0].points.numberOfItems*2 !== coords.points.numberOfItems )
        return false;
      var n, m, baseline_n, coords_n, coords_m,
      offup = 0,
      offdown = 0,
      rot = getTextOrientation(baseline),
      rotmat = rot !== 0 ? self.util.svgRoot.createSVGMatrix().rotate(rot) : null;
      baseline = self.util.pointListToArray(baseline[0].points);
      coords = self.util.pointListToArray(coords.points);
      for ( n = 0; n < baseline.length; n++ ) {
        m = coords.length-1-n;
        baseline_n = rot !== 0 ? baseline[n].matrixTransform(rotmat) : baseline[n];
        coords_n = rot !== 0 ? coords[n].matrixTransform(rotmat) : coords[n];
        coords_m = rot !== 0 ? coords[m].matrixTransform(rotmat) : coords[m];
        if ( n === 0 ) {
          offup = baseline_n.y-coords_n.y;
          offdown = coords_m.y-baseline_n.y;
        }
        else if ( Math.abs( baseline_n.x - coords_n.x ) > 1 ||
                  Math.abs( baseline_n.x - coords_m.x ) > 1 ||
                  Math.abs( (baseline_n.y-coords_n.y) - offup ) > 1 ||
                  Math.abs( (coords_m.y-baseline_n.y) - offdown ) > 1 )
          return false;
      }
      return [ offup+offdown, offdown/(offup+offdown) ];
    }
    self.util.isPolyrect = isPolyrect;

    /**
     * Standardizes a poly-rectangle to start at the top-left and be clockwise.
     */
    function standardizePolyrect( coords, alreadyclockwise ) {
      var
      lr = true,
      rl = true,
      polyrect = false,
      offlrup = 0,
      offlrdw = 0,
      offrldw = 0,
      offrlup = 0,
      parent = $(coords).parent(),
      baseline = $(coords).siblings('.Baseline');

      if ( ! $(coords).hasClass('Coords') ||
           baseline.length === 0 ||
           baseline[0].points.numberOfItems*2 !== coords.points.numberOfItems )
        return false;

      if ( ! ( typeof alreadyclockwise === 'boolean' && alreadyclockwise ) )
        self.util.standardizeClockwise(coords);

      var n, m, baseline_n, coords_n, coords_m,
      rot = getTextOrientation(baseline),
      rotmat = rot !== 0 ? self.util.svgRoot.createSVGMatrix().rotate(rot) : null;
      baseline = self.util.pointListToArray(baseline[0].points);
      coords = self.util.pointListToArray(coords.points);

      for ( n = 0; n < baseline.length; n++ ) {
        m = coords.length-1-n;
        coords_n = rot !== 0 ? coords[n].matrixTransform(rotmat) : coords[n];
        coords_m = rot !== 0 ? coords[m].matrixTransform(rotmat) : coords[m];
        if ( lr ) {
          baseline_n = rot !== 0 ? baseline[n].matrixTransform(rotmat) : baseline[n];
          offlrup += baseline_n.y-coords_n.y;
          offlrdw += coords_m.y-baseline_n.y;
          if ( Math.abs( baseline_n.x - coords_n.x ) > 1 ||
               Math.abs( baseline_n.x - coords_m.x ) > 1 ||
               Math.abs( (baseline_n.y-coords_n.y) - offlrup/(n+1) ) > 1 ||
               Math.abs( (coords_m.y-baseline_n.y) - offlrdw/(n+1) ) > 1 )
            lr = false;
        }
        if ( rl ) {
          m = baseline.length-1-n;
          baseline_n = rot !== 0 ? baseline[m].matrixTransform(rotmat) : baseline[m];
          offrlup += baseline_n.y-coords_m.y;
          offrldw += coords_n.y-baseline_n.y;
          if ( Math.abs( baseline_n.x - coords_n.x ) > 1 ||
               Math.abs( baseline_n.x - coords_m.x ) > 1 ||
               Math.abs( (baseline_n.y-coords_m.y) - offrlup/(n+1) ) > 1 ||
               Math.abs( (coords_n.y-baseline_n.y) - offrldw/(n+1) ) > 1 )
            rl = false;
        }
        if ( ! ( lr || rl ) )
          return false;
      }

      /// top-left clockwise ///
      if ( lr )
        polyrect = [ (offlrup+offlrdw)/baseline.length, offlrdw/(offlrup+offlrdw) ];

      /// bottom-right clockwise ///
      else if ( rl ) {
        polyrect = [ (offrlup+offrldw)/baseline.length, offrlup+offrldw === 0 ? 0 : offrldw/(offrlup+offrldw) ];
        setPolyrect( parent.children('.Baseline')[0], polyrect[0], polyrect[1] );
      }

      return polyrect;
    }

    /**
     * Gets the (average) baseline orientation angle in radians of a given baseline.
     */
    function getBaselineOrientation( elem ) {
      if ( typeof elem === 'undefined' )
        elem = $(self.util.svgRoot).find('.selected');
      var
      g = $(elem).closest('g'),
      baseline = g.children('.Baseline');
      if ( baseline.length === 0 )
        return;

      var
      lgth,
      totlgth = 0,
      angle1st,
      angle,
      avgAngle = 0,
      points = baseline[0].points;

      for ( var n = 1; n < points.numberOfItems; n++ ) {
        lgth = Point2f(points.getItem(n)).euc(points.getItem(n-1));
        totlgth += lgth;
        angle = -Math.atan2( points.getItem(n).y-points.getItem(n-1).y, points.getItem(n).x-points.getItem(n-1).x );
        if ( n === 1 ) {
          angle1st = angle;
          avgAngle += lgth*angle;
        }
        else {
          avgAngle += lgth*(angle1st+angleDiff(angle,angle1st));
        }
      }

      return avgAngle/totlgth;
    }
    self.util.getBaselineOrientation = getBaselineOrientation;

    /**
     * Gets the reading direction of a given element.
     */
    function getReadingDirection( elem ) {
      if ( typeof elem === 'undefined' )
        elem = $(self.util.svgRoot).find('.selected');
      var attr = $(elem).closest('.TextLine').attr('custom');
      if ( typeof attr === 'undefined' ||
           ! attr.match(/readingDirection: *[lrt]t[rlb] *;/) ) {
        attr = $(elem).closest('.TextRegion').attr('readingDirection');
        if ( typeof attr !== 'undefined' )
          return attr.replace(/(.).+-to-(.).+/,'$1t$2');
        return 'ltr';
      }
      return attr.replace(/.*readingDirection: *([lrt]t[rlb]) *;.*/,'$1');
    }
    self.util.getReadingDirection = getReadingDirection;

    /**
     * Gets the text orientation of a given element.
     */
    function getTextOrientation( elem ) {
      if ( typeof elem === 'undefined' )
        elem = $(self.util.svgRoot).find('.selected');
      var attr = $(elem).closest('.TextLine').attr('custom');
      if ( typeof attr === 'undefined' ||
           ! attr.match(/readingOrientation: *[-0-9.]+ *;/) ) {
        attr = $(elem).closest('.TextRegion').attr('readingOrientation');
        if ( typeof attr !== 'undefined' )
          return parseFloat(attr);
        return 0;
      }
      return parseFloat( attr.replace(/.*readingOrientation: *([-0-9.]+) *;.*/,'$1') );
    }
    self.util.getTextOrientation = getTextOrientation;

    /**
     * Gets the confidence value of a TextEquiv element.
     */
    function getTextConf( elem ) {
      if ( typeof elem === 'undefined' )
        elem = $(self.util.svgRoot).find('.selected');
      elem = $(elem).children('.TextEquiv');
      if ( elem.length === 0 || ! elem[0].hasAttribute('conf') )
        return;
      return elem.attr('conf');
    }
    self.util.getTextConf = getTextConf;

    /**
     * Creates a poly-rectangle for a given baseline element.
     */
    function setPolyrect( baseline, height, offset ) {
      if ( ! $(baseline).hasClass('Baseline') ) {
        console.log('error: setPolyrect expects a Baseline element');
        return;
      }
      if ( height <= 0 || offset < 0 || offset > 0.5 )
        return;
      var n,
      coords = $(baseline).siblings('.Coords'),
      offup = height - offset*height,
      offdown = height - offup,
      rot = getTextOrientation(baseline),
      offupmat = self.util.svgRoot.createSVGMatrix().rotate(-rot).translate(0,-offup).rotate(rot),
      offdownmat = self.util.svgRoot.createSVGMatrix().rotate(-rot).translate(0,offdown).rotate(rot);
      if ( coords.length < 1 )
        coords = $(document.createElementNS(self.util.sns,'polygon'))
                   .addClass('Coords')
                   .prependTo( $(baseline).parent() );
      else
        coords[0].points.clear();

      if ( baseline.parentElement.hasAttribute('polyrect') )
        $(baseline.parentElement).attr('polyrect',height+' '+offset);

      baseline = baseline.points;
      coords = coords[0].points;
      for ( n = 0; n < baseline.numberOfItems; n++ )
        coords.appendItem( baseline.getItem(n).matrixTransform(offupmat) );
      for ( n = baseline.numberOfItems-1; n >= 0; n-- )
        coords.appendItem( baseline.getItem(n).matrixTransform(offdownmat) );

      if ( self.cfg.roundPoints )
        for ( n = 0; n < coords.length; n++ ) {
          coords.getItem(n).x = Math.round(coords.getItem(n).x);
          coords.getItem(n).y = Math.round(coords.getItem(n).y);
        }
    }
    self.util.setPolyrect = setPolyrect;

    /**
     * Creates a dragpoint for modifying the height of a polyrect.
     *
     * @param {object}   svgElem          Coords element of polyrect.
     */
    function setPolyrectHeightDragpoint( svgElem ) {
      if ( ! $(svgElem).hasClass('Coords') ) {
        console.log('error: setPolyrectHeightDragpoint expects a Coords element');
        return;
      }
      if ( ! isPolystripe(svgElem) && ! isPolyrect(svgElem) )
        return;

      var
      rootMatrix,
      isprotected,
      ispolystripe,
      polyrect,
      baseline = $(svgElem).siblings('.Baseline')[0],
      dragpoint = document.createElementNS( self.util.sns, 'use' ),
      point = svgElem.points.getItem(0);

      /// Create dragpoint for changing height ///
      dragpoint.setAttributeNS( self.util.xns, 'href', '#'+pageContainer.id+'_dragpoint' );
      dragpoint.setAttribute( 'class', 'dragheight' );
      dragpoint.x.baseVal.value = point.x;
      dragpoint.y.baseVal.value = point.y;

      self.util.svgRoot.appendChild(dragpoint);

      /// Setup dragpoint for dragging ///
      var interactable = interact('#'+pageContainer.id+' .dragheight')
        .draggable( {
            onstart: function ( event ) {
              rootMatrix = self.util.svgRoot.getScreenCTM();
              isprotected = self.util.isReadOnly(svgElem);
              ispolystripe = $(svgElem.parentElement).is('[polystripe]');
              self.util.dragging = true;
            },
            onmove: function ( event ) {
              if ( isprotected )
                return;
              var
              vectup = Point2f(svgElem.points.getItem(0)).subtract(baseline.points.getItem(0)).unit(),
              disp = Point2f(event.dx/rootMatrix.a,event.dy/rootMatrix.d).dot(vectup),
              point = svgElem.points.getItem(0);
              if ( ispolystripe ) {
                polyrect = $(svgElem.parentElement).attr('polystripe').split(' ').map(parseFloat);
                setPolystripe( baseline, polyrect[0]+disp, polyrect[1] );
              }
              else {
                polyrect = $(svgElem.parentElement).attr('polyrect').split(' ').map(parseFloat);
                setPolyrect( baseline, polyrect[0]+disp, polyrect[1] );
              }
              event.target.x.baseVal.value = point.x;
              event.target.y.baseVal.value = point.y;
            },
            onend: function ( event ) {
              window.setTimeout( function () { self.util.dragging = false; }, 100 );
              if ( ! isprotected ) {
                if ( ispolystripe ) {
                  polyrect = $(svgElem).parent().attr('polystripe').split(' ').map(parseFloat);
                  self.cfg.polyrectHeight = polyrect[0];
                  self.util.registerChange('polystripe height change of '+svgElem.parentElement.id);
                }
                else {
                  polyrect = $(svgElem).parent().attr('polyrect').split(' ').map(parseFloat);
                  self.cfg.polyrectHeight = polyrect[0];
                  self.util.registerChange('polyrect height change of '+svgElem.parentElement.id);
                }
              }
            },
            restrict: { restriction: self.util.svgRoot }
          } )
        .styleCursor(false);

      $(svgElem).addClass('editing');

      /// Element function to remove editing ///
      var prevRemove = typeof svgElem.removeEditing !== 'undefined' ?
        svgElem.removeEditing : false ;

      svgElem.removeEditing = function ( unset ) {
        if ( prevRemove )
          prevRemove(false);
        interactable.unset();
        $(self.util.svgRoot).find('.dragheight').remove();
        self.util.unselectElem(svgElem);
        if ( unset )
          delete svgElem.removeEditing;
      };
    }

    /**
     * Modifies the default poly-rectangle parameters and resizes selected Coords.
     */
    function modifyPolyrectParams( deltaHeight, deltaOffset ) {
      var
      coords = $(self.util.svgRoot).find('.selected').closest('g').children('.Coords'),
      polyrect = isPolyrect(coords[0]);
      if ( ! polyrect )
        return false;
      self.cfg.polyrectHeight = deltaHeight + polyrect[0];
      self.cfg.polyrectOffset = deltaOffset + polyrect[1];
      if ( self.cfg.polyrectOffset < 0 || isNaN(self.cfg.polyrectOffset) )
        self.cfg.polyrectOffset = 0;
      else if ( self.cfg.polyrectOffset > 0.5 )
        self.cfg.polyrectOffset = 0.5;
      setPolyrect( coords.siblings('.Baseline')[0], self.cfg.polyrectHeight, self.cfg.polyrectOffset );

      self.util.registerChange('modified polyrect '+coords.parent()[0].id);
    }
    //Mousetrap.bind( 'mod+w', function () { modifyPolyrectParams(2,0); return false; } );
    //Mousetrap.bind( 'mod+e', function () { modifyPolyrectParams(-2,0); return false; } );
    //Mousetrap.bind( 'mod+r', function () { modifyPolyrectParams(0,0.02); return false; } );
    //Mousetrap.bind( 'mod+t', function () { modifyPolyrectParams(0,-0.02); return false; } );

    /**
     * Returns a newly created Baseline (SVG g+polyline) added to the TextRegion for event position.
     */
    function createNewBaseline( event ) {
      var
      textreg = self.util.elementsFromPoint(event,'.TextRegion > .Coords').first().parent();
      if ( self.util.isReadOnly(textreg) ) {
        console.log('error: target region cannot be modified');
        return false;
      }
      if ( textreg.length === 0 ) {
        console.log('error: baselines have to be inside a TextRegion');
        return false;
      }

      var
      id = '',
      reglines = textreg.find('.TextLine'),
      numline = reglines.length+1,
      elem = $(document.createElementNS(self.util.sns,'polyline'))
               .addClass('Baseline'),
      g = $(document.createElementNS(self.util.sns,'g'))
            .addClass('TextLine')
            .append(elem);

      if ( reglines.length > 0 )
        g.insertAfter(reglines.last());
      else
        g.appendTo(textreg);

      if ( self.cfg.newElemID ) {
        id = self.cfg.newElemID(textreg,'TextLine',event);
        if ( typeof id !== 'string' ) {
          g.remove();
          console.log('error: problem generating element ID');
          return false;
        }
      }
      if ( ! id ) {
        while ( $('#'+pageContainer.id+' #'+textreg[0].id+'_l'+numline).length > 0 )
          numline++;
        id = textreg[0].id+'_l'+numline;
      }
      g.attr('id',id);

      if ( self.cfg.readingDirection !== getReadingDirection(textreg) )
        g.attr( 'custom',
          ( g[0].hasAttribute('custom') ? g.attr('custom')+' ' : '' ) +
          'readingDirection: '+self.cfg.readingDirection+';' );

      if ( self.cfg.textOrientation !== -getTextOrientation(textreg) )
        g.attr( 'custom',
          ( g[0].hasAttribute('custom') ? g.attr('custom')+' ' : '' ) +
          'readingOrientation: '+(-self.cfg.textOrientation)+';' );

      self.util.selectElem(elem,true,true);

      return elem[0];
    }

    /**
     * Computes the difference between two angles [-PI,PI] unaffected by the discontinuity
     */
    function angleDiff( a1, a2 ) {
      var a = a1 - a2;
      a += (a>Math.PI) ? -2*Math.PI : (a<-Math.PI) ? 2*Math.PI : 0;
      return a;
    }

    /**
     * Checks that points are left to right and inside the corresponding region.
     */
    function isValidBaseline( points, elem, complete ) {
      /*var
      rot = getTextOrientation(elem),
      rotmat = rot !== 0 ? self.util.svgRoot.createSVGMatrix().rotate(rot) : null;

      for ( var n = 1; n < points.length; n++ )
        if ( ( rot === 0 && points[n].x <= points[n-1].x ) ||
             ( rot !== 0 && points[n].matrixTransform(rotmat).x <= points[n-1].matrixTransform(rotmat).x ) ) {
          console.log('error: baselines have to be left to right (after line rotation)');
          return false;
        }*/

      /// Check baseline orientation angles ///
      var prevAngle, angle, range = self.cfg.baselineFirstAngleRange;
      for ( var n = 1; n < points.length; n++ ) {
        angle = -Math.atan2( points[n].y-points[n-1].y, points[n].x-points[n-1].x );
        if ( n > 1 ) {
          if ( Math.abs(angleDiff(angle,prevAngle)) > self.cfg.baselineMaxAngleDiff ) {
            console.log('error: consecutive baseline segments angle exceeds maximum: Δangle='+Math.abs(angleDiff(angle,prevAngle)*180/Math.PI)+'° max='+self.cfg.baselineMaxAngleDiff*180/Math.PI);
            return false;
          }
        }
        else if ( n === 1 && range ) {
          if ( ( range[0] < range[1] && ( angle < range[0] || angle > range[1] ) ) ||
               ( range[0] > range[1] && ( angle < range[0] && angle > range[1] ) ) ) {
            console.log('error: first baseline segment outside angle range: angle='+(angle*180/Math.PI)+'° range=['+range[0]*180/Math.PI+','+range[1]*180/Math.PI+']');
            return false;
          }
        }
        prevAngle = angle;
      }

      /// Check that the baseline is completely inside parent TextRegion ///
      if ( elem && self.cfg.baselinesInRegs ) {
        var
        pt = self.util.toScreenCoords(points[points.length-1]),
        textreg = $(elem).closest('.TextRegion'),
        reg = self.util.elementsFromPoint(pt,'.TextRegion > .Coords').parent();
        if ( reg.length === 0 || $.inArray(textreg[0],reg) < 0 ) {
          console.log('error: baselines have to be inside a single TextRegion');
          return false;
        }
      }

      /// Require a minimum length for the baseline ///
      if ( complete ) {
        var lgth=0;
        for ( n=points.length-1; n>=1; n-- )
          lgth += Math.sqrt( (points[n].x-points[n-1].x)*(points[n].x-points[n-1].x) + (points[n].y-points[n-1].y)*(points[n].y-points[n-1].y) );
        if ( lgth < self.cfg.pointsMinLength ) {
          console.log('error: baselines are required to have a length of at least '+self.cfg.pointsMinLength+' pixels');
          return false;
        }
      }

      return true;
    }

    /**
     * Creates polyrect, sorts line within region, sets the editable, selects it and registers change.
     */
    function finishBaseline( baseline ) {
      //setPolyrect( baseline, self.cfg.polyrectHeight, self.cfg.polyrectOffset );
      setPolystripe( baseline, self.cfg.polyrectHeight, self.cfg.polyrectOffset );

      sortOnDrop( $(baseline).parent()[0] );

      $(baseline)
        .parent()
        .addClass('editable')
        .each( function () {
            this.setEditing = function () {
                var event = { target: this };
                self.util.setEditing( event, 'points', { points_selector: '> polyline', restrict: false } );
              };
          } );
      window.setTimeout( function () {
          if ( typeof $(baseline).parent()[0].setEditing !== 'undefined' )
            $(baseline).parent()[0].setEditing();
          self.util.selectElem(baseline,true);
        }, 50 );

      for ( var n=0; n<self.cfg.onFinishBaseline.length; n++ )
        self.cfg.onFinishBaseline[n](baseline);

      self.util.registerChange('added baseline '+$(baseline).parent().attr('id'));
    }

    /**
     * In baseline edit mode add dragpoint to change polyrect height.
     */
    self.cfg.onSelect.push( function ( elem ) {
        if ( $(elem).is('.Baseline.selected') && $(elem).parent().is('.editing') )
          setPolyrectHeightDragpoint( $(elem).siblings('.Coords')[0] );
      } );

    /**
     * In baseline edit mode add polyrect attribute.
     */
    self.cfg.onSetEditing.push( function ( elem ) {
        var coords = $(elem.parentElement).find('#'+elem.id+'.TextLine:has(>.Baseline) >.Coords, #'+elem.id+' .TextLine:has(>.Baseline) >.Coords');
        coords.each( function () {
            var polystripe = isPolystripe(this);
            if ( polystripe )
              $(this.parentElement).attr('polystripe',polystripe[0]+' '+polystripe[1]);
            else {
              var polyrect = isPolyrect(this);
              if ( polyrect )
                $(this.parentElement).attr('polyrect',polyrect[0]+' '+polyrect[1]);
            }
          } );
      } );

    /**
     * Remove polyrect attributes on remove editings.
     */
    self.cfg.onRemoveEditing.push( function ( elem ) {
        $(elem).find('.TextLine').add(elem).removeAttr('polyrect').removeAttr('polystripe');
      } );

    /**
     * Update polyrect when the baseline points change.
     */
    self.cfg.onPointsChange.push( function ( baseline ) {
        var coords = $(baseline).siblings('.Coords');
        if ( coords.length === 0 || ! coords.parent().is('[polyrect],[polystripe]') )
          return;

        /// Update Coords points ///
        if ( coords.parent().is('[polystripe]') ) {
          var polystripe = coords.parent().attr('polystripe').split(' ').map(parseFloat);
          setPolystripe( baseline, polystripe[0], polystripe[1] );
        }
        else {
          var polyrect = coords.parent().attr('polyrect').split(' ').map(parseFloat);
          setPolyrect( baseline, polyrect[0], polyrect[1] );
        }

        /// Update position of dragpoint for changing polyrect height ///
        var dragheight = $(self.util.svgRoot).find('.dragheight');
        if ( dragheight.length > 0 ) {
          dragheight[0].x.baseVal.value = coords[0].points.getItem(0).x;
          dragheight[0].y.baseVal.value = coords[0].points.getItem(0).y;
        }
      } );

    /**
     * Initializes the create line mode.
     */
    function editModeBaselineCreate() {
      self.mode.off();
      var args = arguments;
      self.mode.current = function () { return editModeBaselineCreate.apply(this,args); };
      if ( ! self.util.svgRoot )
        return true;

      self.util.selectFiltered('.TextLine')
        .addClass('editable')
        .each( function () {
            this.setEditing = function ( ) {
                var event = { target: this };
                self.util.setEditing( event, 'points', { points_selector: '> polyline', restrict: false } );
              };
          } );

      self.util.setDrawPoly( createNewBaseline, isValidBaseline, finishBaseline, removeElem, self.cfg.baselineMaxPoints );

      //self.util.prevEditing();

      return false;
    }

    /**
     * Removes an element.
     */
    function removeElem( elem ) {
      $(elem).closest('g').remove();
    }

    /**
     * Returns a newly created Coords (SVG g+polygon).
     */
    function createNewCoords( event, elem_selector, elem_type, parent_selector, parent_type, id_prefix ) {
      /*var point = self.util.toViewboxCoords(event);
      if ( point.x < 0 || point.y < 0 ||
           point.x > canvasSize.W-1 || point.y > canvasSize.H-1 ) {
        console.log('error: '+elem_type+'s have to be within image limits');
        return false;
      }*/

      var
      parent = self.util.elementsFromPoint(event,parent_selector+' > .Coords, '+parent_selector+' > .PageImage').parent();
      if ( parent.length === 0 ) {
        console.log('error: '+elem_type+'s have to be inside a '+parent_selector);
        return false;
      }
      if ( self.util.isReadOnly(parent) ) {
        console.log('error: target '+parent_type+' cannot be modified');
        return false;
      }

      var
      id = '',
      num = parent.children(elem_selector).length+1,
      sibl = parent.children(),
      siblprev = sibl.filter('.Property, .Coords, .PageImage, '+elem_selector),
      elem = $(document.createElementNS(self.util.sns,'polygon'))
               .addClass('Coords'),
      g = $(document.createElementNS(self.util.sns,'g'))
            .addClass(elem_type)
            .append(elem);

      // @todo Configurable function that inserts the element in a position based on some other criteria

      if ( siblprev.length > 0 )
        g.insertAfter(siblprev.last());
      else if ( sibl.length > 0 )
        g.insertBefore(sibl.first());
      else
        g.appendTo(parent);

      if ( self.cfg.newElemID ) {
        id = self.cfg.newElemID(parent,elem_type,event);
        if ( typeof id !== 'string' ) {
          g.remove();
          console.log('error: problem generating element ID');
          return false;
        }
      }
      if ( ! id ) {
        id = id_prefix[0] === '*' ? parent[0].id+id_prefix.substr(1) : id_prefix;
        while ( $('#'+pageContainer.id+' #'+id+num).length > 0 )
          num++;
        id = id+num;
      }
      g.attr('id',id);

      if ( elem_type === 'TextRegion' ) {
        if ( self.cfg.readingDirection !== 'ltr' )
          g.attr( 'readingDirection', readDirs[self.cfg.readingDirection] );
        if ( self.cfg.textOrientation !== 0 )
          g.attr( 'readingOrientation', -self.cfg.textOrientation );
      }
      // @todo Handle other cases

      self.util.selectElem(elem,true,true);

      return elem[0];
    }

    /**
     * Checks that points are within image limits and has at least 3 points.
     */
    function isValidCoords( points, elem, complete, elem_type ) {
      var
      pt = self.util.toScreenCoords(points[0]),
      page = typeof elem === 'undefined' ?
        self.util.elementsFromPoint(pt,'.PageImage')[0].getBBox():
        $(elem).closest('.Page').children('.PageImage')[0].getBBox();
      for ( var n = 1; n < points.length; n++ )
        if ( points[n].x < page.x || points[n].y < page.y ||
             points[n].x > page.x+page.width-1 || points[n].y > page.y+page.height-1 ) {
          console.log('error: '+elem_type+'s have to be within page limits');
          return false;
        }
      //for ( var n = 1; n < points.length; n++ )
      //  if ( points[n].x < 0 || points[n].y < 0 ||
      //       points[n].x > canvasSize.W-1 || points[n].y > canvasSize.H-1 ) {
      //    console.log('error: '+elem_type+'s have to be within image limits');
      //    return false;
      //  }
      if ( complete ) {
        if ( points.length < 3 ) {
          console.log('error: '+elem_type+'s are required to have at least 3 points');
          return false;
        }
        var min_x=Infinity, min_y=Infinity, max_x=0, max_y=0;
        for ( n=points.length-1; n>=0; n-- ) {
          if ( points[n].x < min_x ) min_x = points[n].x;
          if ( points[n].y < min_y ) min_y = points[n].y;
          if ( points[n].x > max_x ) max_x = points[n].x;
          if ( points[n].y > max_y ) max_y = points[n].y;
        } 
        if ( (max_x-min_x+1) < self.cfg.pointsMinLength || (max_y-min_y+1) < self.cfg.pointsMinLength ) {
          console.log('error: '+elem_type+'s are required to have width and height of at least '+self.cfg.pointsMinLength+' pixels');
          return false;
        }
      }
      return true;
    }

    /**
     * Finishes the creation of a Coords element (SVG g+polygon).
     */
    function finishCoords( coords, elem_type, restrict ) {
      self.util.standardizeQuad(coords);

      $(coords)
        .parent()
        .addClass('editable')
        .each( function () {
            this.setEditing = function ( ) {
                var event = { target: this };
                self.util.setEditing( event, 'points', { points_selector: '> polygon', restrict: restrict } );
              };
          } );
      window.setTimeout( function () { $(coords).parent()[0].setEditing(); self.util.selectElem(coords,true); }, 50 );

      for ( var n=0; n<self.cfg.onFinishCoords.length; n++ )
        self.cfg.onFinishCoords[n](coords,elem_type,restrict);

      self.util.registerChange('added '+elem_type+' '+$(coords).parent().attr('id'));
    }

    /**
     * Initializes the mode for creating Coords elements (SVG g+polygon).
     *
     * @param {string}   restrict         Whether to restrict polygon to rectangle.
     * @param {string}   elem_selector    CSS selector for elements to enable editing.
     * @param {string}   elem_type        Type for element to create.
     * @param {string}   parent_type      Type of required parent element.
     * @param {string}   id_prefix        Prefix for setting element id. First character '*' is replaced by parent id.
     */
    function editModeCoordsCreate( restrict, elem_selector, elem_type, parent_selector, parent_type, id_prefix ) {
      restrict = restrict ? 'rect' : false;
      self.mode.off();
      var args = arguments;
      self.mode.current = function () { return editModeCoordsCreate.apply(this,args); };
      if ( ! self.util.svgRoot )
        return true;

      self.util.selectFiltered(elem_selector)
        .addClass('editable')
        .each( function () {
            this.setEditing = function ( ) {
                var event = { target: this };
                self.util.setEditing( event, 'points', { points_selector: '> polygon', restrict: restrict } );
              };
          } );

      function createpoly( event ) { return createNewCoords( event, elem_selector, elem_type, parent_selector, parent_type, id_prefix ); }
      function isvalidpoly( points, elem, complete ) { return isValidCoords(points, elem, complete, elem_type); }
      function onfinish( elem ) { return finishCoords( elem, elem_type, restrict ); }

      if ( ! restrict )
        self.util.setDrawPoly( createpoly, isvalidpoly, onfinish, removeElem, self.cfg.coordsMaxPoints );
      else
        self.util.setDrawRect( createpoly, isvalidpoly, onfinish, removeElem );

      //self.util.prevEditing();

      return false;
    }
    self.mode.editModeCoordsCreate = editModeCoordsCreate;

    /**
     * Adds a relation between a two selected elements.
     *
     * @param {array}     elems    Array with the elements.
     * @param {string}    type     Type of relation, either 'link' or 'join'.
     */
    function createRelation( elems, type, afterCreate ) {
      if ( elems.length !== 2 )
        return;

      var
      id = '',
      numrel = 1,
      elemFrom = $(elems[0]).closest('g'),
      elemTo = $(elems[1]).closest('g'),
      page = elemFrom.closest('.Page'),
      relations = page.children('.Relations'),
      relation = $(document.createElementNS(self.util.sns,'g'))
        .addClass('Relation')
        .attr('data-type',type);

      if ( relations.length === 0 ) {
        var
        elems_after = page.children('.TextRegion, .TableRegion');
        relations = $(document.createElementNS(self.util.sns,'g'))
          .addClass('Relations');

        if ( elems_after.length > 0 )
          relations.insertBefore( elems_after.first() );
        else
          relations.appendTo(page);
      }

      if ( self.cfg.newElemID ) {
        id = self.cfg.newElemID(page,'Relation');
        if ( typeof id !== 'string' ) {
          console.log('error: problem generating element ID');
          return false;
        }
      }
      if ( ! id ) {
        while ( $(self.util.svgRoot).find('#rel'+numrel).length > 0 )
          numrel++;
        id = 'rel'+numrel;
      }
      relation.attr('id',id);

      $(document.createElementNS(self.util.sns,'g'))
        .addClass('RegionRef')
        .attr('regionRef',elemFrom[0].id)
        .appendTo(relation);
      $(document.createElementNS(self.util.sns,'g'))
        .addClass('RegionRef')
        .attr('regionRef',elemTo[0].id)
        .appendTo(relation);

      relation.appendTo(relations);

      $(self.util.svgRoot).find('.prev-editing').removeClass('prev-editing');
      elemFrom.addClass('prev-editing');

      if ( afterCreate )
        afterCreate(relation);

      self.util.registerChange('added relation '+id+': '+elemFrom[0].id+' -> '+elemTo[0].id);
    }

    /**
     * Enables a mode for adding relations between two elements.
     *
     * @param {array}     elem_selectors    CSS selectors for relation elements.
     * @param {function}  isValidRelation   Function that tests whether the selected elements are valid for the relation (array of selected elements as argument).
     * @param {function}  afterRelationAdd  Function to execute after the relation has been created (relation element as argument).
     */
    function editModeAddRelation( elem_selectors, isValidRelation, afterRelationAdd, relType ) {
      if ( typeof relType === 'undefined' )
        relType = 'join';

      function elementsSelected( elems ) {
        if ( isValidRelation(elems) )
          createRelation(elems,relType,afterRelationAdd);
        else
        self.mode.current();
      }

      self.mode.selectMultiple(elem_selectors,2,undefined,elementsSelected);
    }


    ////////////////////
    /// Table modes  ///
    ////////////////////

    /**
     * Returns a newly created TextRegion (SVG g+polygon).
     */
    function createNewTable( event ) {
      if ( self.util.isReadOnly() ) {
        console.log('error: page cannot be modified');
        return false;
      }

      /*var point = self.util.toViewboxCoords(event);
      if ( point.x < 0 || point.y < 0 ||
           point.x > canvasSize.W-1 || point.y > canvasSize.H-1 ) {
        console.log('error: tables have to be within image limits');
        return false;
      }*/

      var
      parent = self.util.elementsFromPoint(event,'.Page > .PageImage').parent();
      if ( parent.length === 0 ) {
        console.log('error: TableRegions have to be inside a Page');
        return false;
      }

      var
      id = '',
      rows = self.cfg.tableSize[0] >= 1 ? Math.round(self.cfg.tableSize[0]) : 3,
      cols = self.cfg.tableSize[1] >= 1 ? Math.round(self.cfg.tableSize[1]) : 3,
      numtab = $(self.util.svgRoot).find('.Page > .TableRegion').length+1,
      elem = $(document.createElementNS(self.util.sns,'polygon'))
               .addClass('Coords'),
      g = $(document.createElementNS(self.util.sns,'g'))
            .addClass('TableRegion')
            .append(elem);

      g.attr('rows',rows)
       .attr('columns',cols)
       .appendTo(parent);

      if ( self.cfg.newElemID ) {
        id = self.cfg.newElemID(parent,'TableRegion',event);
        if ( typeof id !== 'string' ) {
          g.remove();
          console.log('error: problem generating element ID');
          return false;
        }
      }
      if ( ! id ) {
        while ( $('#'+pageContainer.id+' #table'+numtab).length > 0 )
          numtab++;
        id = 'table'+numtab;
      }
      g.attr('id',id);

      //self.util.selectElem(elem,true,true);

      return elem[0];
    }

    /**
     * Sets region points editable, selects it and registers change.
     */
    function finishTable( table ) {
      self.util.standardizeQuad(table);

      var r, c,
      id = table.parentElement.id,
      tab = self.util.pointListToArray(table.points),
      rows = parseInt( $(table.parentElement).attr('rows') ),
      cols = parseInt( $(table.parentElement).attr('columns') ),
      after = $(table.parentElement);

      for ( c=1; c<=cols; c++ )
        for ( r=1; r<=rows; r++ ) {
          var
          elem = $(document.createElementNS(self.util.sns,'polygon'))
            .attr('points',$(table).attr('points'))
            .addClass('Coords'),
          elem_points = self.util.pointListToArray(elem[0].points),

          top1    = c == 1    ? Point2f(tab[0]) : Point2f(tab[1]).subtract(tab[0]).hadamard((c-1)/cols).add(tab[0]),
          top2    = c == cols ? Point2f(tab[1]) : Point2f(tab[1]).subtract(tab[0]).hadamard(c/cols)    .add(tab[0]),
          bottom1 = c == 1    ? Point2f(tab[3]) : Point2f(tab[2]).subtract(tab[3]).hadamard((c-1)/cols).add(tab[3]),
          bottom2 = c == cols ? Point2f(tab[2]) : Point2f(tab[2]).subtract(tab[3]).hadamard(c/cols)    .add(tab[3]),
          left1   = r == 1    ? Point2f(tab[0]) : Point2f(tab[3]).subtract(tab[0]).hadamard((r-1)/rows).add(tab[0]),
          left2   = r == rows ? Point2f(tab[3]) : Point2f(tab[3]).subtract(tab[0]).hadamard(r/rows)    .add(tab[0]),
          right1  = r == 1    ? Point2f(tab[1]) : Point2f(tab[2]).subtract(tab[1]).hadamard((r-1)/rows).add(tab[1]),
          right2  = r == rows ? Point2f(tab[2]) : Point2f(tab[2]).subtract(tab[1]).hadamard(r/rows)    .add(tab[1]);
          intersection( top1, bottom1, left1, right1, elem_points[0] );
          intersection( top2, bottom2, left1, right1, elem_points[1] );
          intersection( top2, bottom2, left2, right2, elem_points[2] );
          intersection( top1, bottom1, left2, right2, elem_points[3] );

          after = $(document.createElementNS(self.util.sns,'g'))
            .addClass('TextRegion TableCell')
            .attr('tableid',id)
            .attr('id',id+'_'+r+'_'+c)
            .append(elem)
            .insertAfter(after);
        }

      $(self.util.svgRoot)
        .find('.TextRegion[id^='+id+']')
        .addClass('editable')
        .each( function () {
            this.setEditing = function ( ) {
                var event = { target: this };
                self.util.setEditing( event, 'select' );
              };
          } );
      window.setTimeout( function () {
          var elem = $(self.util.svgRoot).find('.TextRegion[id^='+id+']')[0];
          elem.setEditing();
          self.util.selectElem(elem,true);
        }, 50 );

      for ( var n=0; n<self.cfg.onFinishTable.length; n++ )
        self.cfg.onFinishTable[n](table);

      self.util.registerChange('added table '+id);
    }

    /**
     * Initializes the create table mode.
     */
    function editModeTableCreate( restrict ) {
      restrict = restrict ? 'rect' : false;
      self.mode.off();
      var args = arguments;
      self.mode.current = function () { return editModeTableCreate.apply(this,args); };
      if ( ! self.util.svgRoot )
        return true;

      self.util.selectFiltered('.TableCell')
        .addClass('editable')
        .each( function () {
            this.setEditing = function ( ) {
                var event = { target: this };
                self.util.setEditing( event, 'select' );
              };
          } );

      function isvalidpoly( points, elem, complete ) { return isValidCoords(points, elem, complete, 'TableRegion'); }

      var setDraw = restrict ? self.util.setDrawRect : self.util.setDrawPoly;
      setDraw( createNewTable, isvalidpoly, finishTable, removeElem, 4 );

      //self.util.prevEditing();

      return false;
    }

    /**
     * A class for operating with (x,y) points.
     */
    function Point2f( val1, val2 ) {
      if ( ! ( this instanceof Point2f ) )
        return new Point2f(val1,val2);
      if ( typeof val1 === 'undefined' && typeof val2 === 'undefined' )
        return new Point2f(0,0);
      if ( typeof val2 === 'undefined' ) {
        this.x += typeof val1.x === 'undefined' ? val1 : val1.x ;
        this.y += typeof val1.y === 'undefined' ? val1 : val1.y ;
      }
      else {
        this.x = val1;
        this.y = val2;
      }
      return this;
    }
    Point2f.prototype.x = null;
    Point2f.prototype.y = null;
    Point2f.prototype.set = function( val ) {
      if ( ! val || typeof val.x === 'undefined' || typeof val.y === 'undefined' )
        return false;
      if ( typeof val.x.baseVal != 'undefined' ) {
        val.x.baseVal.value = this.x;
        val.y.baseVal.value = this.y;
      }
      else {
        val.x = this.x;
        val.y = this.y;
      }
      return true;
    };
    Point2f.prototype.copy = function( val ) {
      this.x = val.x;
      this.y = val.y;
      return this;
    };
    Point2f.prototype.add = function( val ) {
      this.x += typeof val.x === 'undefined' ? val : val.x ;
      this.y += typeof val.y === 'undefined' ? val : val.y ;
      return this;
    };
    Point2f.prototype.subtract = function( val ) {
      this.x -= typeof val.x === 'undefined' ? val : val.x ;
      this.y -= typeof val.y === 'undefined' ? val : val.y ;
      return this;
    };
    Point2f.prototype.hadamard = function( val ) {
      this.x *= typeof val.x === 'undefined' ? val : val.x ;
      this.y *= typeof val.y === 'undefined' ? val : val.y ;
      return this;
    };
    Point2f.prototype.dot = function( val ) {
      return this.x*val.x + this.y*val.y ;
    };
    Point2f.prototype.norm = function() {
      return Math.sqrt( this.x*this.x + this.y*this.y );
    };
    Point2f.prototype.euc2 = function( val ) {
      var dx = this.x-val.x, dy = this.y-val.y;
      return dx*dx + dy*dy;
    };
    Point2f.prototype.euc = function( val ) {
      var dx = this.x-val.x, dy = this.y-val.y;
      return Math.sqrt( dx*dx + dy*dy );
    };
    Point2f.prototype.unit = function() {
      var norm = Math.sqrt( this.x*this.x + this.y*this.y );
      this.x /= norm;
      this.y /= norm;
      return this;
    };
    Point2f.prototype.tosvg = function() {
      var point = self.util.svgRoot.createSVGPoint();
      point.x = this.x;
      point.y = this.y;
      return point;
    };

    /**
     * Checks if a point is within a line segment
     */
    function pointInSegment( segm_start, segm_end, point ) {
      var
      segm = Point2f(segm_end).subtract(segm_start),
      start_point = Point2f(segm_start).subtract(point),
      end_point = Point2f(segm_end).subtract(point);
      return 1.0001*segm.dot(segm) >= start_point.dot(start_point) + end_point.dot(end_point);
    }

    /**
     * Checks if a point is within a line segment
     */
    function withinSegment( segm_start, segm_end, point ) {
      var
      a = Point2f(segm_start),
      b = Point2f(segm_end),
      c = Point2f(point),
      ab = a.euc(b),
      ac = a.euc(c),
      bc = b.euc(c),
      area = Math.abs( a.x*(b.y-c.y) + b.x*(c.y-a.y) + c.x*(a.y-b.y) ) / (2*(ab+ac+bc)*(ab+ac+bc));

      /// check collinearity (normalized triangle area) ///
      if ( area > 1e-3 )
        return;
      /// return zero if in segment ///
      if ( ac <= ab && bc <= ab )
        return 0;
      /// return +1 if to the right and -1 if to the left ///
      return ac > bc ? 1 : -1;
    }

    /**
     * Returns +1, -1 or 0 depending on which side a point lies with respect to a line
     */
    function sideOfLine( line_p1, line_p2, point ) {
      var val = (line_p1.x-line_p2.x)*(point.y-line_p2.y)-(line_p1.y-line_p2.y)*(point.x-line_p2.x);
      if ( val === 0 )
        return 0;
      return val > 0 ? 1 : -1;
    }

    /**
     * Finds the intersection point between two lines defined by pairs of points or returns false if no intersection
     */
    function intersection( line1_point1, line1_point2, line2_point1, line2_point2, _ipoint ) {
      var
      x = Point2f(line2_point1).subtract(line1_point1),
      direct1 = Point2f(line1_point2).subtract(line1_point1),
      direct2 = Point2f(line2_point2).subtract(line2_point1),

      cross = direct1.x*direct2.y - direct1.y*direct2.x;
      if( Math.abs(cross) < /*EPS*/1e-8 )
        return false;

      var
      t1 = (x.x * direct2.y - x.y * direct2.x)/cross;
      Point2f(line1_point1).add(direct1.hadamard(t1)).set(_ipoint);

      return true;
    }

    /**
     * Computes a point on a line that extends beyond a segment a factor of its length
     */
    function extendSegment( segment1, segment2, factor, _point ) {
      var
      segment = Point2f(segment2).subtract(segment1),
      length = segment.norm();
      segment.x /= length;
      segment.y /= length;
      Point2f( segment2 )
        .add( segment.hadamard(factor*length) )
        .set( _point );
    }

    /**
     * Selects a polygon point from a table cell.
     */
    function cellPoint( table, item, cell ) {
      var poly = ( cell ? 
        table.cells.filter('#'+table.tabid+'_'+cell[0]+'_'+cell[1]) :
        table.tabregion ).children('polygon');
      return poly.length === 0 ? null : poly[0].points.getItem(item) ;
    }

    /**
     * Returns an object with information about current editing cell.
     */
    function editingCellInfo( getcells ) {
      var
      editing = {},
      cell = $(self.util.svgRoot).find('.editing');
      if ( cell.length === 0 ||
           ! cell.hasClass('TableCell') )
        return false;
      editing.cell = cell;
      editing.tabid = cell.attr('tableid');
      editing.tabregion = $(self.util.svgRoot).find('#'+editing.tabid);
      editing.rows = parseInt(editing.tabregion.attr('rows'));
      editing.cols = parseInt(editing.tabregion.attr('columns'));
      editing.row = parseInt(editing.cell.attr('id').replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
      editing.col = parseInt(editing.cell.attr('id').replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
      if ( typeof getcells !== 'undefined' && getcells )
        editing.cells = $(self.util.svgRoot).find('.TextRegion[id^="'+editing.tabid+'_"]');
      return editing;
    }

    /**
     * Moves selected/editing table cell.
     */
    function cellChange( row, col ) {
      var editing = editingCellInfo();
      if ( ! editing )
        return true;
      row += editing.row;
      if ( row >= 1 && row <= editing.rows )
        editing.row = row;
      col += editing.col;
      if ( col >= 1 && col <= editing.cols )
        editing.col = col;
      $(self.util.svgRoot).find('#'+editing.tabid+'_'+editing.row+'_'+editing.col).click();
      return false;
    }
    Mousetrap.bind( 'alt+right', function () { return cellChange(0,1); } );
    Mousetrap.bind( 'alt+left', function () { return cellChange(0,-1); } );
    Mousetrap.bind( 'alt+up', function () { return cellChange(-1,0); } );
    Mousetrap.bind( 'alt+down', function () { return cellChange(1,0); } );

    /**
     * Handles the adding of table rows or columns.
     */
    function addRowCol( addtype ) {
      var row, col, corner1, corner2, points,
      editing = editingCellInfo(true);
      if ( ! editing )
        return true;

      self.mode.off();

      var regexCellPrefix = new RegExp('^'+editing.tabid+'_[0-9]+_[0-9]+_');

      switch ( addtype ) {
        case 'col':
          editing.tabregion.attr('columns',editing.cols+1);
          editing.cells.filter('[id^="'+editing.tabid+'_"][id$="_'+editing.col+'"]')
            .clone().each( function () {
                $(this).children(':not(.Coords)').remove();
                row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
                col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
                points = self.util.pointListToArray($(this).children('polygon')[0].points);
                Point2f(points[0]).add(points[1]).hadamard(0.5).set(points[0]);
                Point2f(points[3]).add(points[2]).hadamard(0.5).set(points[3]);
                Point2f(points[0]).set(cellPoint(editing,1,[row,col]));
                Point2f(points[3]).set(cellPoint(editing,2,[row,col]));
                this.id = editing.tabid+'_'+row+'_'+(col+1);
              } )
            .insertAfter(editing.cells.filter('#'+editing.tabid+'_'+editing.rows+'_'+editing.col));
          editing.cells.each( function () {
              col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
              if ( col > editing.col ) {
                row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
                var cellId = editing.tabid+'_'+row+'_'+(col+1);
                this.id = cellId;
                $(this).find('g').each( function () {
                    if ( regexCellPrefix.test(this.id) )
                      this.id = this.id.replace(regexCellPrefix,cellId+'_');
                  } );
              }
            } );
          col = editing.col + 1;
          row = editing.row;
          break;
        case 'row':
          editing.tabregion.attr('rows',editing.rows+1);
          editing.cells.filter('[id^="'+editing.tabid+'_'+editing.row+'_"]')
            .clone().each( function () {
                $(this).children(':not(.Coords)').remove();
                row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
                col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
                points = self.util.pointListToArray($(this).children('polygon')[0].points);
                Point2f(points[0]).add(points[3]).hadamard(0.5).set(points[0]);
                Point2f(points[1]).add(points[2]).hadamard(0.5).set(points[1]);
                Point2f(points[0]).set(cellPoint(editing,3,[row,col]));
                Point2f(points[1]).set(cellPoint(editing,2,[row,col]));
                $(this).insertAfter(editing.cells.filter('#'+this.id));
                this.id = editing.tabid+'_'+(row+1)+'_'+col;
              } );
          editing.cells.each( function () {
              row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
              if ( row > editing.row ) {
                col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
                var cellId = editing.tabid+'_'+(row+1)+'_'+col;
                this.id = cellId;
                $(this).find('g').each( function () {
                    if ( regexCellPrefix.test(this.id) )
                      this.id = this.id.replace(regexCellPrefix,cellId+'_');
                  } );
              }
            } );
          row = editing.row + 1;
          col = editing.col;
          break;
      }

      self.util.registerChange('added '+addtype+' for cell ('+editing.row+','+editing.col+') in table '+editing.tabid);
      self.mode.current();
      $(self.util.svgRoot).find('#'+editing.tabid+'_'+row+'_'+col).click();
    }
    self.util.addRowCol = addRowCol;
    Mousetrap.bind( 'plus c', function () { return addRowCol('col'); } );
    Mousetrap.bind( 'plus r', function () { return addRowCol('row'); } );

    /**
     * Handles the removal of table rows or columns.
     */
    function delRowCol( rmtype ) {
      var row, col,
      editing = editingCellInfo(true);
      if ( ! editing ||
           ( rmtype === 'col' && editing.cols < 2 ) ||
           ( rmtype === 'row' && editing.rows < 2 ) ||
           ! self.cfg.delRowColConfirm( editing.tabid,
               rmtype === 'row' ? editing.row : 0,
               rmtype === 'col' ? editing.col : 0 ) )
        return true;

      var regexCellPrefix = new RegExp('^'+editing.tabid+'_[0-9]+_[0-9]+_');

      switch ( rmtype ) {
        case 'col':
          editing.cells.filter('[id^="'+editing.tabid+'_"][id$="_'+editing.col+'"]').remove();
          editing.tabregion.attr('columns',editing.cols-1);
          if ( editing.col === editing.cols ) {
            Point2f( cellPoint(editing,1,[1,editing.cols-1]) ).set( cellPoint(editing,1) );
            Point2f( cellPoint(editing,2,[editing.rows,editing.cols-1]) ).set( cellPoint(editing,2) );
          }
          else if ( editing.col === 1 ) {
            Point2f( cellPoint(editing,1,[1,1]) ).set( cellPoint(editing,0) );
            Point2f( cellPoint(editing,2,[editing.rows,1]) ).set( cellPoint(editing,3) );
            editing.cells.each( function () {
                row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
                col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
                var cellId = editing.tabid+'_'+row+'_'+(col-1);
                this.id = cellId;
                $(this).find('g').each( function () {
                    if ( regexCellPrefix.test(this.id) )
                      this.id = this.id.replace(regexCellPrefix,cellId+'_');
                  } );
              } );
          }
          else
            editing.cells.each( function () {
                col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
                row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
                if ( col > editing.col ) {
                  var cellId = editing.tabid+'_'+row+'_'+(col-1);
                  this.id = cellId;
                  $(this).find('g').each( function () {
                      if ( regexCellPrefix.test(this.id) )
                        this.id = this.id.replace(regexCellPrefix,cellId+'_');
                    } );
                }
                else if ( col === editing.col-1 ) {
                  Point2f( cellPoint(editing,0,[row,col+2]) ).set( cellPoint(editing,1,[row,col]) );
                  Point2f( cellPoint(editing,3,[row,col+2]) ).set( cellPoint(editing,2,[row,col]) );
                }
              } );
          break;
        case 'row':
          editing.cells.filter('[id^="'+editing.tabid+'_'+editing.row+'_"]').remove();
          editing.tabregion.attr('rows',editing.rows-1);
          if ( editing.row === editing.rows ) {
            Point2f( cellPoint(editing,3,[editing.rows-1,1]) ).set( cellPoint(editing,3) );
            Point2f( cellPoint(editing,2,[editing.rows-1,editing.cols]) ).set( cellPoint(editing,2) );
          }
          else if ( editing.row === 1 ) {
            Point2f( cellPoint(editing,0,[2,1]) ).set( cellPoint(editing,0) );
            Point2f( cellPoint(editing,1,[2,editing.cols]) ).set( cellPoint(editing,1) );
            editing.cells.each( function () {
                row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
                col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
                var cellId = editing.tabid+'_'+(row-1)+'_'+col;
                this.id = cellId;
                $(this).find('g').each( function () {
                    if ( regexCellPrefix.test(this.id) )
                      this.id = this.id.replace(regexCellPrefix,cellId+'_');
                  } );
              } );
          }
          else
            editing.cells.each( function () {
                row = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$1'));
                col = parseInt(this.id.replace(/^.+_([0-9]+)_([0-9]+)$/,'$2'));
                if ( row > editing.row ) {
                  var cellId = editing.tabid+'_'+(row-1)+'_'+col;
                  this.id = cellId;
                  $(this).find('g').each( function () {
                      if ( regexCellPrefix.test(this.id) )
                        this.id = this.id.replace(regexCellPrefix,cellId+'_');
                    } );
                }
                else if ( row === editing.row-1 ) {
                  Point2f( cellPoint(editing,0,[row+2,col]) ).set( cellPoint(editing,3,[row,col]) );
                  Point2f( cellPoint(editing,1,[row+2,col]) ).set( cellPoint(editing,2,[row,col]) );
                }
              } );
          break;
      }

      self.util.registerChange('deleted '+rmtype+' for cell ('+editing.row+','+editing.col+') in table '+editing.tabid);
    }
    self.util.delRowCol = delRowCol;
    Mousetrap.bind( '- c', function () { return delRowCol('col'); } );
    Mousetrap.bind( '- r', function () { return delRowCol('row'); } );

    /**
     * Initializes the table points edit mode.
     */
    function editModeTablePoints( restrict ) {
      restrict = restrict ? 'rect' : false;
      self.mode.off();
      var args = arguments;
      self.mode.current = function () { return editModeTablePoints.apply(this,args); };
      if ( ! self.util.svgRoot )
        return true;

      self.util.selectFiltered('.TableRegion')
        .addClass('editable')
        .click( function ( event ) {
            if ( ! self.util.dragging ) {
              var elem = $(event.target).closest('.editable')[0];
              if ( ! elem.removeEditing )
                setEditTablePoints( elem, restrict );
            }
            event.stopPropagation();
            event.preventDefault();
          } )
        .each( function () {
            $(self.util.svgRoot).find('.TextRegion[id^="'+this.id+'_"] polygon')
              .addClass('no-pointer-events');
          } );

      self.util.prevEditing();

      return false;
    }

    /**
     * Checks whether the regions in a table form a grid.
     *
     * @param {object}   table          The table object.
     */
    function isGridTable( table ) {
      var pt0, pt1, pt2, pt3,
      rows = table.rows,
      cols = table.cols,
      coords = table.tabregion.children('.Coords')[0].points;
      for ( var n=0; n<4; n++ )
        if ( Point2f(coords.getItem(n)).euc2(Point2f(table.corners[n])) > 1e-3 )
          return false;
      for ( n=2; n<cols; n++ ) {
        pt0 = Point2f(cellPoint( table, 1, [1,n-1] ));
        pt1 = Point2f(cellPoint( table, 0, [1,n] ));
        pt2 = Point2f(cellPoint( table, 2, [rows,n-1] ));
        pt3 = Point2f(cellPoint( table, 3, [rows,n] ));
        if ( pt0.euc2(pt1) > 1e-3 || pt2.euc2(pt3) > 1e-3 )
          return false;
      }
      for ( n=2; n<rows; n++ ) {
        pt0 = Point2f(cellPoint( table, 3, [n-1,1] ));
        pt1 = Point2f(cellPoint( table, 0, [n,1] ));
        pt2 = Point2f(cellPoint( table, 2, [n-1,cols] ));
        pt3 = Point2f(cellPoint( table, 1, [n,cols] ));
        if ( pt0.euc2(pt1) > 1e-3 || pt2.euc2(pt3) > 1e-3 )
          return false;
      }
      return true;
    }

    /**
     * Makes the points of a Page table editable.
     *
     * @param {object}   elem          Selected element for editing.
     */
    function setEditTablePoints( elem, restrict ) {
      var
      rootMatrix,
      isprotected,
      originalPoints = [],
      transformedPoints = [],
      rows = parseInt($(elem).attr('rows')),
      cols = parseInt($(elem).attr('columns')),
      table = {
        rows: rows,
        cols: cols,
        tabid: elem.id,
        tabregion: $(elem),
        cells: $(self.util.svgRoot).find('.TextRegion[id^="'+elem.id+'_"]') };

      if ( table.cells.length !== rows*cols )
        return self.throwError( 'Table structure problem in '+elem.id+': rows='+rows+' cols='+cols+' vs. cells='+table.cells.length );

      table.cells.each( function () {
          if ( $(this).children('polygon')[0].points.numberOfItems !== 4 )
            return self.throwError( 'Non-quadrilateral table cell: '+this.id );
        } );

      //if ( resetedit )
        self.util.removeEditings();

      self.util.dragpointScale();

      function newDragpoint( item, cell ) {
        var
        dragpoint = document.createElementNS( self.util.sns, 'use' ),
        point = cellPoint( table, item, cell ),
        newPoint = self.util.svgRoot.createSVGPoint();

        dragpoint.setAttributeNS( self.util.xns, 'href', '#'+pageContainer.id+'_dragpoint' );
        dragpoint.setAttribute( 'class', 'dragpoint' );
        dragpoint.x.baseVal.value = newPoint.x = point.x;
        dragpoint.y.baseVal.value = newPoint.y = point.y;

        originalPoints.push( newPoint );

        self.util.svgRoot.appendChild(dragpoint);

        return dragpoint;
      }

      var n,
      topleft = cellPoint( table, 0, [1,1] ),
      topright = cellPoint( table, 1, [1,cols] ),
      bottomright = cellPoint( table, 2, [rows,cols] ),
      bottomleft = cellPoint( table, 3, [rows,1] );
      table.corners = [ topleft, topright, bottomright, bottomleft ];

      if ( ! isGridTable(table) )
        return self.util.setEditPoints( elem, '~ .TableCell[id^="'+elem.id+'_"] > polygon', restrict );

      /// Create a dragpoint for each editable point ///
      for ( n=1; n<=cols; n++ )
        $( newDragpoint( 0, [1,n] ) )
          .addClass( n > 1 ? 'table-border top' : 'table-corner top-left' )
          .attr( { row: 0, col: n-1 } );

      for ( n=1; n<=rows; n++ )
        $( newDragpoint( 1, [n,cols] ) )
          .addClass( n > 1 ? 'table-border right' : 'table-corner top-right' )
          .attr( { row: n-1, col: cols } );

      for ( n=cols; n>=1; n-- )
        $( newDragpoint( 2, [rows,n] ) )
          .addClass( n < cols ? 'table-border bottom' : 'table-corner bottom-right' )
          .attr( { row: rows, col: n } );

      for ( n=rows; n>=1; n-- )
        $( newDragpoint( 3, [n,1] ) )
          .addClass( n < rows ? 'table-border left' : 'table-corner bottom-left' )
          .attr( { row: n, col: 0 } );

      var
      row, col, corner, pcorner,
      ipoints, opp1, opp2, side,
      isect = Point2f(),
      point1 = Point2f(),
      point2,
      side_orig1, side_orig2,
      fact_orig1, fact_orig2,
      fact_opp_orig1, fact_opp_orig2,
      dir_opp1, dir_opp2,
      fact_now1, fact_now2,
      line_p1, line_p2, line_p3,
      limit1_p1, limit1_p2,
      limit2_p1, limit2_p2,
      band_limit1_p1, band_limit1_p2,
      band_limit2_p1, band_limit2_p2;

      /// Setup dragpoints for dragging ///
      var interactable = interact('#'+pageContainer.id+' .dragpoint')
        .draggable( {
            onstart: function ( event ) {
              isprotected = self.util.isReadOnly(elem);
              if ( isprotected )
                return;
              self.util.dragging = true;
              $(self.util.svgRoot).find('.dragpoint.activepoint').removeClass('activepoint');
              $(event.target).addClass('activepoint');

              var n;

              rootMatrix = self.util.svgRoot.getScreenCTM();

              corner = false;
              ipoints = [];
              row = event.target.getAttribute('row')|0;
              col = event.target.getAttribute('col')|0;

              if ( $(event.target).hasClass('top') ) {
                line_p1 = topleft;
                line_p2 = topright;
                point2 = cellPoint( table, 2, [rows,col] );
                limit1_p1 = cellPoint( table, 0, [1,col] );
                limit1_p2 = cellPoint( table, 3, [rows,col] );
                limit2_p1 = cellPoint( table, 1, [1,col+1] );
                limit2_p2 = cellPoint( table, 2, [rows,col+1] );
                opp1 = [ cellPoint( table, 3, [rows,col+1] ),
                         $(self.util.svgRoot).find('use[row="'+rows+'"][col="'+col+'"]')[0] ];
                for ( n=1; n<=rows; n++ )
                  ipoints.push( [ point1, point2,
                    cellPoint( table, 0, [n,1] ), cellPoint( table, 1, [n,cols] ),
                    cellPoint( table, 1, [n,col] ), cellPoint( table, 0, [n,col+1] ), // points
                    cellPoint( table, 2, [n-1,col] ), cellPoint( table, 3, [n-1,col+1] ) ] );
              }
              else if ( $(event.target).hasClass('bottom') ) {
                line_p1 = bottomleft;
                line_p2 = bottomright;
                point2 = cellPoint( table, 1, [1,col] );
                limit1_p2 = cellPoint( table, 0, [1,col] );
                limit1_p1 = cellPoint( table, 3, [rows,col] );
                limit2_p2 = cellPoint( table, 1, [1,col+1] );
                limit2_p1 = cellPoint( table, 2, [rows,col+1] );
                opp1 = [ cellPoint( table, 0, [1,col+1] ),
                         $(self.util.svgRoot).find('use[row="0"][col="'+col+'"]')[0] ];
                for ( n=1; n<=rows; n++ )
                  ipoints.push( [ point1, point2,
                    cellPoint( table, 3, [n,1] ), cellPoint( table, 2, [n,cols] ),
                    cellPoint( table, 2, [n,col] ), cellPoint( table, 3, [n,col+1] ), // points
                    cellPoint( table, 1, [n+1,col] ), cellPoint( table, 0, [n+1,col+1] ) ] );
              }
              else if ( $(event.target).hasClass('left') ) {
                line_p1 = topleft;
                line_p2 = bottomleft;
                point2 = cellPoint( table, 2, [row,cols] );
                limit1_p1 = cellPoint( table, 0, [row,1] );
                limit1_p2 = cellPoint( table, 1, [row,cols] );
                limit2_p1 = cellPoint( table, 3, [row+1,1] );
                limit2_p2 = cellPoint( table, 2, [row+1,cols] );
                opp1 = [ cellPoint( table, 1, [row+1,cols] ),
                         $(self.util.svgRoot).find('use[row="'+row+'"][col="'+cols+'"]')[0] ];
                for ( n=1; n<=cols; n++ )
                  ipoints.push( [ point1, point2,
                    cellPoint( table, 0, [1,n] ), cellPoint( table, 3, [rows,n] ),
                    cellPoint( table, 3, [row,n] ), cellPoint( table, 0, [row+1,n] ), // points
                    cellPoint( table, 2, [row,n-1] ), cellPoint( table, 1, [row+1,n-1] ) ] );
              }
              else if ( $(event.target).hasClass('right') ) {
                line_p1 = topright;
                line_p2 = bottomright;
                point2 = cellPoint( table, 3, [row,1] );
                limit1_p2 = cellPoint( table, 0, [row,1] );
                limit1_p1 = cellPoint( table, 1, [row,cols] );
                limit2_p2 = cellPoint( table, 3, [row+1,1] );
                limit2_p1 = cellPoint( table, 2, [row+1,cols] );
                opp1 = [ cellPoint( table, 0, [row+1,1] ),
                         $(self.util.svgRoot).find('use[row="'+row+'"][col="0"]')[0] ];
                for ( n=1; n<=cols; n++ )
                  ipoints.push( [ point1, point2,
                    cellPoint( table, 1, [1,n] ), cellPoint( table, 2, [rows,n] ),
                    cellPoint( table, 2, [row,n] ), cellPoint( table, 1, [row+1,n] ), // points
                    cellPoint( table, 3, [row,n+1] ), cellPoint( table, 0, [row+1,n+1] ) ] );
              }
              else if ( $(event.target).hasClass('top-left') ) {
                line_p1 = bottomleft;
                line_p2 = topright;
                line_p3 = bottomright;
                limit1_p1 = cellPoint( table, 3, [1,1] );
                limit1_p2 = cellPoint( table, 2, [1,cols] );
                limit2_p1 = cellPoint( table, 1, [1,1] );
                limit2_p2 = cellPoint( table, 2, [rows,1] );
                corner = topleft;
                pcorner = cellPoint( table, 0 );
                opp1 = [ cellPoint( table, 1 ),
                         $(self.util.svgRoot).find('use[row="0"][col="'+cols+'"]')[0] ];
                opp2 = [ cellPoint( table, 3 ),
                         $(self.util.svgRoot).find('use[row="'+rows+'"][col="0"]')[0] ];
                for ( n=1; n<cols; n++ )
                  ipoints.push( [ point1, topright,
                    cellPoint( table, 1, [1,n] ), cellPoint( table, 2, [rows,n] ),
                    cellPoint( table, 1, [1,n] ), cellPoint( table, 0, [1,n+1] ),
                    $(self.util.svgRoot).find('use[row="0"][col="'+n+'"]')[0] ] );
                for ( n=1; n<rows; n++ )
                  ipoints.push( [ point1, bottomleft,
                    cellPoint( table, 3, [n,1] ), cellPoint( table, 2, [n,cols] ),
                    cellPoint( table, 3, [n,1] ), cellPoint( table, 0, [n+1,1] ),
                    $(self.util.svgRoot).find('use[row="'+n+'"][col="0"]')[0] ] );
              }
              else if ( $(event.target).hasClass('top-right') ) {
                line_p1 = bottomright;
                line_p2 = topleft;
                line_p3 = bottomleft;
                limit1_p1 = cellPoint( table, 2, [1,cols] );
                limit1_p2 = cellPoint( table, 3, [1,1] );
                limit2_p1 = cellPoint( table, 0, [1,cols] );
                limit2_p2 = cellPoint( table, 3, [rows,cols] );
                corner = topright;
                pcorner = cellPoint( table, 1 );
                opp1 = [ cellPoint( table, 0 ),
                         $(self.util.svgRoot).find('use[row="0"][col="0"]')[0] ];
                opp2 = [ cellPoint( table, 2 ),
                         $(self.util.svgRoot).find('use[row="'+rows+'"][col="'+cols+'"]')[0] ];
                for ( n=1; n<cols; n++ )
                  ipoints.push( [ point1, topleft,
                    cellPoint( table, 1, [1,n] ), cellPoint( table, 2, [rows,n] ),
                    cellPoint( table, 1, [1,n] ), cellPoint( table, 0, [1,n+1] ),
                    $(self.util.svgRoot).find('use[row="0"][col="'+n+'"]')[0] ] );
                for ( n=1; n<rows; n++ )
                  ipoints.push( [ point1, bottomright,
                    cellPoint( table, 3, [n,1] ), cellPoint( table, 2, [n,cols] ),
                    cellPoint( table, 2, [n,cols] ), cellPoint( table, 1, [n+1,cols] ),
                    $(self.util.svgRoot).find('use[row="'+n+'"][col="'+cols+'"]')[0] ] );
              }
              else if ( $(event.target).hasClass('bottom-right') ) {
                line_p1 = topright;
                line_p2 = bottomleft;
                line_p3 = topleft;
                limit1_p1 = cellPoint( table, 1, [rows,cols] );
                limit1_p2 = cellPoint( table, 0, [rows,1] );
                limit2_p1 = cellPoint( table, 3, [rows,cols] );
                limit2_p2 = cellPoint( table, 0, [1,cols] );
                corner = bottomright;
                pcorner = cellPoint( table, 2 );
                opp1 = [ cellPoint( table, 3 ),
                         $(self.util.svgRoot).find('use[row="'+rows+'"][col="0"]')[0] ];
                opp2 = [ cellPoint( table, 1 ),
                         $(self.util.svgRoot).find('use[row="0"][col="'+cols+'"]')[0] ];
                for ( n=1; n<cols; n++ )
                  ipoints.push( [ point1, bottomleft,
                    cellPoint( table, 1, [1,n] ), cellPoint( table, 2, [rows,n] ),
                    cellPoint( table, 2, [rows,n] ), cellPoint( table, 3, [rows,n+1] ),
                    $(self.util.svgRoot).find('use[row="'+rows+'"][col="'+n+'"]')[0] ] );
                for ( n=1; n<rows; n++ )
                  ipoints.push( [ point1, topright,
                    cellPoint( table, 3, [n,1] ), cellPoint( table, 2, [n,cols] ),
                    cellPoint( table, 2, [n,cols] ), cellPoint( table, 1, [n+1,cols] ),
                    $(self.util.svgRoot).find('use[row="'+n+'"][col="'+cols+'"]')[0] ] );
              }
              else if ( $(event.target).hasClass('bottom-left') ) {
                line_p1 = topleft;
                line_p2 = bottomright;
                line_p3 = topright;
                limit1_p1 = cellPoint( table, 0, [rows,1] );
                limit1_p2 = cellPoint( table, 1, [rows,cols] );
                limit2_p1 = cellPoint( table, 2, [rows,1] );
                limit2_p2 = cellPoint( table, 1, [1,1] );
                corner = bottomleft;
                pcorner = cellPoint( table, 3 );
                opp1 = [ cellPoint( table, 2 ),
                         $(self.util.svgRoot).find('use[row="'+rows+'"][col="'+cols+'"]')[0] ];
                opp2 = [ cellPoint( table, 0 ),
                         $(self.util.svgRoot).find('use[row="0"][col="0"]')[0] ];
                for ( n=1; n<cols; n++ )
                  ipoints.push( [ point1, bottomright,
                    cellPoint( table, 1, [1,n] ), cellPoint( table, 2, [rows,n] ),
                    cellPoint( table, 2, [rows,n] ), cellPoint( table, 3, [rows,n+1] ),
                    $(self.util.svgRoot).find('use[row="'+rows+'"][col="'+n+'"]')[0] ] );
                for ( n=1; n<rows; n++ )
                  ipoints.push( [ point1, topleft,
                    cellPoint( table, 3, [n,1] ), cellPoint( table, 2, [n,cols] ),
                    cellPoint( table, 3, [n,1] ), cellPoint( table, 0, [n+1,1] ),
                    $(self.util.svgRoot).find('use[row="'+n+'"][col="0"]')[0] ] );
              }

              point1.x = event.target.x.baseVal.value;
              point1.y = event.target.y.baseVal.value;
              band_limit1_p1 = Point2f(point1).subtract(line_p1).unit().hadamard(self.cfg.pointsMinLength).add(limit1_p1);
              band_limit2_p1 = Point2f(point1).subtract(line_p2).unit().hadamard(self.cfg.pointsMinLength).add(limit2_p1);
              if ( corner ) {
                band_limit1_p2 = Point2f(line_p2).subtract(line_p3).unit().hadamard(self.cfg.pointsMinLength).add(limit1_p2);
                band_limit2_p2 = Point2f(line_p1).subtract(line_p3).unit().hadamard(self.cfg.pointsMinLength).add(limit2_p2);

                //fact_orig1 = Point2f(limit1_p1).euc(point1) / Point2f(limit1_p1).euc(line_p1);
                //fact_orig2 = Point2f(limit2_p1).euc(point1) / Point2f(limit2_p1).euc(line_p2);
                //fact_opp_orig1 = Point2f(limit1_p2).euc(line_p2) / Point2f(limit1_p2).euc(line_p3);
                //fact_opp_orig2 = Point2f(limit2_p2).euc(line_p1) / Point2f(limit2_p2).euc(line_p3);
                fact_orig1 = Point2f(limit1_p1).euc(point1);
                fact_orig2 = Point2f(limit2_p1).euc(point1);
                fact_opp_orig1 = Point2f(limit1_p2).euc(line_p2);
                fact_opp_orig2 = Point2f(limit2_p2).euc(line_p1);
                dir_opp1 = Point2f(line_p2).subtract(line_p3).unit();
                dir_opp2 = Point2f(line_p1).subtract(line_p3).unit();
                side_orig1 = sideOfLine(limit1_p1,limit1_p2,point1);
                side_orig2 = sideOfLine(limit2_p1,limit2_p2,point1);
              }
              else {
                fact_orig1 = Point2f(limit1_p1).euc(point1) / Point2f(limit1_p1).euc(limit2_p1);
                fact_opp_orig1 = Point2f(limit1_p2).euc(point2) / Point2f(limit1_p2).euc(limit2_p2);
              }
            },
            onmove: function ( event ) {
              if ( isprotected )
                return;

              point1.x = event.target.x.baseVal.value;
              point1.y = event.target.y.baseVal.value;
              point1.x += event.dx / rootMatrix.a;
              point1.y += event.dy / rootMatrix.d;
              if ( self.cfg.roundPoints ) {
                point1.x = Math.round(point1.x);
                point1.y = Math.round(point1.y);
              }

              if ( ! corner ) {
                if ( ! intersection( line_p1, line_p2, point1, point2, isect ) )
                  return;
                point1.copy(isect);

                //side = withinSegment( limit1_p1, limit2_p1, point1 );
                side = withinSegment( band_limit1_p1, band_limit2_p1, point1 );
                if ( typeof side !== 'undefined' ) {
                  if ( side > 0 )
                    //point1.copy(limit2_p1);
                    point1.copy(band_limit2_p1);
                  else if ( side < 0 )
                    //point1.copy(limit1_p1);
                    point1.copy(band_limit1_p1);
                }

                if ( ! event.shiftKey ) {
                  fact_now1 = Point2f(limit1_p1).euc(point1) / Point2f(limit1_p1).euc(limit2_p1);
                  extendSegment( limit2_p2, limit1_p2, -fact_opp_orig1*fact_now1/fact_orig1, point2 );
                  for ( n=opp1.length-1; n>=0; n-- )
                    Point2f(point2).set(opp1[n]);
                }
              }
              else {
                //intersection( point1, line_p1, limit1_p1, limit1_p2, isect );
                //if ( ! pointInSegment( point1, line_p1, isect ) )
                //  point1.copy(isect);
                //intersection( point1, line_p2, limit2_p1, limit2_p2, isect );
                //if ( ! pointInSegment( point1, line_p2, isect ) )
                //  point1.copy(isect);
                if ( sideOfLine(band_limit1_p1,band_limit1_p2,point1) !== side_orig1 )
                  intersection( point1, line_p1, band_limit1_p1, band_limit1_p2, point1 );
                if ( sideOfLine(band_limit2_p1,band_limit2_p2,point1) !== side_orig2 )
                  intersection( point1, line_p2, band_limit2_p1, band_limit2_p2, point1 );
                //if ( sideOfLine(limit1_p1,limit1_p2,point1) !== side_orig1 )
                //  intersection( point1, line_p1, limit1_p1, limit1_p2, point1 );
                //if ( sideOfLine(limit2_p1,limit2_p2,point1) !== side_orig2 )
                //  intersection( point1, line_p2, limit2_p1, limit2_p2, point1 );

                if ( ! event.shiftKey ) {
                  //fact_now1 = Point2f(limit1_p1).euc(point1) / Point2f(limit1_p1).euc(line_p1);
                  //fact_now2 = Point2f(limit2_p1).euc(point1) / Point2f(limit2_p1).euc(line_p2);
                  //extendSegment( line_p3, limit1_p2, fact_opp_orig1*fact_now1/fact_orig1, line_p2 );
                  //extendSegment( line_p3, limit2_p2, fact_opp_orig2*fact_now2/fact_orig2, line_p1 );
                  fact_now1 = Point2f(limit1_p1).euc(point1) / fact_orig1;
                  fact_now2 = Point2f(limit2_p1).euc(point1) / fact_orig2;
                  Point2f(dir_opp1).hadamard(fact_opp_orig1*fact_now1).add(limit1_p2).set(line_p2);
                  Point2f(dir_opp2).hadamard(fact_opp_orig2*fact_now2).add(limit2_p2).set(line_p1);

                  for ( n=opp1.length-1; n>=0; n-- )
                    Point2f(line_p2).set(opp1[n]);
                  for ( n=opp2.length-1; n>=0; n-- )
                    Point2f(line_p1).set(opp2[n]);
                }
              }

              for ( var n=0; n<ipoints.length; n++ ) {
                intersection( ipoints[n][0], ipoints[n][1], ipoints[n][2], ipoints[n][3], isect );
                for ( var m=4; m<ipoints[n].length; m++ ) {
                  if ( ! ipoints[n][m] )
                    continue;
                  if ( typeof ipoints[n][m].nodeName === 'undefined' )
                    isect.set(ipoints[n][m]);
                  else {
                    ipoints[n][m].x.baseVal.value = isect.x;
                    ipoints[n][m].y.baseVal.value = isect.y;
                  }
                }
              }

              if ( corner ) {
                point1.set(corner);
                point1.set(pcorner);
              }

              event.target.x.baseVal.value = point1.x;
              event.target.y.baseVal.value = point1.y;
            },
            onend: function ( event ) {
              window.setTimeout( function () { self.util.dragging = false; }, 100 );
              if ( isprotected )
                return;
              self.util.registerChange('points edit for table '+elem.id);
            },
            restrict: { restriction: self.util.svgRoot }
          } )
        .styleCursor(false);

      $(elem).addClass('editing');
      self.util.selectElem( elem );
      table.cells.addClass('selected');

      /// Element function to remove editing ///
      var prevRemove = typeof elem.removeEditing !== 'undefined' ?
        elem.removeEditing : false ;

      elem.removeEditing = function ( unset ) {
        if ( prevRemove )
          prevRemove(false);
        interactable.unset();
        $(self.util.svgRoot).find('.dragpoint').remove();
        $(elem).removeClass('editing');
        table.cells.removeClass('selected');
        self.util.unselectElem(elem);
        if ( unset )
          delete elem.removeEditing;
      };
    }

    return self;
  } // function PageCanvas( pageContainer, config ) {

})( window );

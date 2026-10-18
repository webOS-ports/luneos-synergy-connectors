/*global console */
/* flickr_service.js - main service assistant. OAuth 1.0a / REST photo-source connector.
 * Flickr is a PHOTO source only (browse + download into the stock Photos app); there is
 * no documents/files role, so this service hosts only the auth + photo-provider commands.
 */
function FlickrService() {}
FlickrService.prototype = {
	setup: function () { console.log("FlickrService (OAuth 1.0a / REST) setup"); return; }
};

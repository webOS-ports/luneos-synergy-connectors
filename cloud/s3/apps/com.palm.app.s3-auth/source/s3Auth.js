/*global enyo, console */
/*
 * S3Auth - customUI account validator for the generic S3-compatible connector. Collects the
 * five things any S3 endpoint needs - endpoint host, region, bucket, access key id, secret access
 * key (plus a path-style toggle) - and calls com.palm.service.s3/login, which SigV4-signs a test
 * ListObjectsV2 to validate them before Accounts stores the account. No OAuth, no webview.
 */
enyo.kind({
	name: "S3Auth",
	kind: enyo.VFlexBox,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Image", name: "headerIcon", className: "accounts-header-icon", showing: false },
			{ kind: "Control", name: "title", content: "S3 Storage" }
		]},
		{ name: "svc", kind: "PalmService", onFailure: "svcFailure" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", style: "padding:16px;", components: [
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:10px;",
					content: "Connect any S3-compatible storage (Amazon S3, IDrive e2, Backblaze B2, Wasabi, MinIO…). Enter the endpoint and your access keys — they stay on the device." },
				{ kind: "Input", name: "endpointField", hint: "Endpoint host (e.g. s3.us-west-1.idrivee2.com)",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%;" },
				{ kind: "Input", name: "regionField", hint: "Region (e.g. us-east-1)",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%; margin-top:8px;" },
				{ kind: "Input", name: "bucketField", hint: "Bucket name",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%; margin-top:8px;" },
				{ kind: "Input", name: "keyField", hint: "Access key ID",
					spellcheck: false, style: "width:100%; margin-top:8px;" },
				{ kind: "Input", name: "secretField", hint: "Secret access key",
					type: "password", spellcheck: false, style: "width:100%; margin-top:8px;" },
				{ kind: "control", style: "margin-top:10px; display:flex; align-items:center;", components: [
					{ name: "pathStyleToggle", kind: "CheckBox", checked: true },
					{ kind: "Control", className: "accounts-body-text", style: "margin-left:8px;",
						content: "Path-style URLs (needed for most non-AWS endpoints)" }
				]},
				{ name: "status", className: "accounts-body-text", style: "padding-top:10px; color:#b00000;" }
			]}
		]},
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ name: "connectButton", kind: "Button", caption: "Connect",
				className: "enyo-button-dark accounts-btn", onclick: "connectTap" },
			{ kind: "Button", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
		]},
		{ name: "xresult", kind: "enyo.CrossAppResult" }
	],

	create: function () {
		this.inherited(arguments);
		this.done = false;
		this.params = enyo.windowParams || {};
		var tmpl = this.params.template || {};
		var addr = (tmpl.validator && tmpl.validator.address) || "";
		this.serviceUri = addr.replace(/login\/*$/, "");
		if (!this.serviceUri && this.params.account && this.params.account.capabilityProviders) {
			var cps = this.params.account.capabilityProviders;
			for (var i = 0; i < cps.length; i++) {
				if (cps[i] && cps[i].implementation) { this.serviceUri = cps[i].implementation; break; }
			}
		}
		if (this.serviceUri && this.serviceUri.charAt(this.serviceUri.length - 1) !== "/") { this.serviceUri += "/"; }
		if (this.serviceUri) { this.$.svc.setService(this.serviceUri); }
		if (tmpl.loc_name) { this.$.title.setContent(tmpl.loc_name); }
		var iconPath = tmpl.icon && (tmpl.icon.loc_48x48 || tmpl.icon.loc_32x32);
		if (iconPath) { this.$.headerIcon.setSrc(iconPath); this.$.headerIcon.setShowing(true); }
	},

	connectTap: function () {
		if (this.done) { return; }
		var payload = {
			endpoint:        (this.$.endpointField.getValue() || "").replace(/^\s+|\s+$/g, ""),
			region:          (this.$.regionField.getValue() || "").replace(/^\s+|\s+$/g, ""),
			bucket:          (this.$.bucketField.getValue() || "").replace(/^\s+|\s+$/g, ""),
			accessKeyId:     (this.$.keyField.getValue() || "").replace(/^\s+|\s+$/g, ""),
			secretAccessKey: (this.$.secretField.getValue() || ""),
			pathStyle:       this.$.pathStyleToggle.getChecked()
		};
		if (!payload.endpoint || !payload.bucket || !payload.accessKeyId || !payload.secretAccessKey) {
			this.$.status.setContent("Please fill in the endpoint, bucket, access key and secret."); return;
		}
		if (!this.serviceUri) { this.finish({ returnValue: false, errorCode: "NO_SERVICE" }); return; }
		this.$.status.setContent("Connecting…");
		this.$.connectButton.setDisabled(true);
		this.$.svc.call(payload, { method: "login", onSuccess: "authSuccess", onFailure: "authFailed" });
	},

	authFailed: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		this.$.status.setContent("Could not connect — check the endpoint, region, bucket and keys.");
		this.log("s3-auth: login failed " + enyo.json.stringify(inResponse));
	},

	authSuccess: function (inSender, inResponse) {
		if (this.params && this.params.template) {
			inResponse.templateId = this.params.template.templateId;
			inResponse.template   = this.params.template;
		}
		this.finish(inResponse);
	},

	svcFailure: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		this.finish({ returnValue: false, errorCode: "SERVICE_UNAVAILABLE", detail: inResponse });
	},

	cancel: function () {
		if (this.done) { return; }
		this.finish({});
	},

	finish: function (result) {
		this.done = true;
		this.log("s3-auth: sending result " + enyo.json.stringify(result));
		this.$.xresult.sendResult(result);
	}
});

/*
 *  Discord Plugin for Pidgin
 *  Copyright (C) 2021-2022 Eion Robb
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */



/* webOS: the OpenSSL backend below is fully implemented (RSA-OAEP-SHA256 via EVP),
 * so do NOT undef it on Linux like upstream did (upstream left it a stub). */

#if !defined USE_MBEDTLS_CRYPTO && !defined USE_OPENSSL_CRYPTO && !defined USE_NSS_CRYPTO && !defined USE_GCRYPT_CRYPTO
// #	ifdef _WIN32
// #		define USE_WIN32_CRYPTO
// #	else
#		define USE_NSS_CRYPTO
// #	endif
#endif


// Info from https://gitlab.com/beeper/discord/-/tree/main/remoteauth
//       and https://luna.gitlab.io/discord-unofficial-docs/desktop_remote_auth.html


static void
discord_null_cb() {
}

/* webOS: Discord can require an hCaptcha to finish the remote-auth (QR) ticket->token
 * exchange. discord_fetch_token_and_start_socket surfaces that captcha through
 * purple_request_fields (fields below), the transport hands the sitekey/rqdata to the
 * accounts UI which solves it in an embedded browser, and the solved response token is
 * fed back here as the editable "captcha_key" field. We then re-POST remote-auth/login
 * with {ticket, captcha_key, captcha_rqtoken} to get the encrypted token. */
static void
discord_captcha_submit_cb(gpointer user_data, PurpleRequestFields *fields)
{
	DiscordAccount *da = (DiscordAccount *)user_data;
	const gchar *captcha_key = purple_request_fields_get_string(fields, "captcha_key");

	if (captcha_key == NULL || *captcha_key == '\0') {
		purple_debug_error("discord", "captcha submit with empty key\n");
		purple_connection_error(da->pc, PURPLE_CONNECTION_ERROR_AUTHENTICATION_FAILED,
		                        _("Captcha was not completed"));
		return;
	}

	purple_debug_info("discord", "captcha solved, re-posting remote-auth/login\n");

	JsonObject *data = json_object_new();
	json_object_set_string_member(data, "ticket", da->qr_ticket ? da->qr_ticket : "");
	json_object_set_string_member(data, "captcha_key", captcha_key);
	if (da->captcha_rqtoken)
		json_object_set_string_member(data, "captcha_rqtoken", da->captcha_rqtoken);
	gchar *postdata = json_object_to_string(data);

	discord_fetch_url(da,
	                  "https://" DISCORD_API_SERVER "/api/" DISCORD_API_VERSION "/users/@me/remote-auth/login",
	                  postdata, discord_fetch_token_and_start_socket, NULL);

	g_free(postdata);
	json_object_unref(data);
}

static void
discord_display_captcha(PurpleConnection *pc, const gchar *service, const gchar *sitekey,
                        const gchar *rqdata, const gchar *rqtoken)
{
	DiscordAccount *da = purple_connection_get_protocol_data(pc);
	PurpleRequestUiOps *ui_ops = purple_request_get_ui_ops();

	if (!ui_ops || !ui_ops->request_fields) {
		purple_connection_error(pc, PURPLE_CONNECTION_ERROR_AUTHENTICATION_FAILED,
		    _("Discord requires a captcha, which this client cannot display."));
		return;
	}

	PurpleRequestFields *fields = purple_request_fields_new();
	PurpleRequestFieldGroup *group = purple_request_field_group_new(NULL);
	purple_request_fields_add_group(fields, group);

	PurpleRequestField *field;
	/* Read-only parameters the UI needs to render the hCaptcha widget. */
	field = purple_request_field_string_new("captcha_service", _("Captcha Service"),
	                                        service ? service : "hcaptcha", FALSE);
	purple_request_field_string_set_editable(field, FALSE);
	purple_request_field_group_add_field(group, field);

	field = purple_request_field_string_new("captcha_sitekey", _("Captcha Sitekey"),
	                                        sitekey ? sitekey : "", FALSE);
	purple_request_field_string_set_editable(field, FALSE);
	purple_request_field_group_add_field(group, field);

	field = purple_request_field_string_new("captcha_rqdata", _("Captcha Rqdata"),
	                                        rqdata ? rqdata : "", TRUE);
	purple_request_field_string_set_editable(field, FALSE);
	purple_request_field_group_add_field(group, field);

	field = purple_request_field_string_new("captcha_rqtoken", _("Captcha Rqtoken"),
	                                        rqtoken ? rqtoken : "", TRUE);
	purple_request_field_string_set_editable(field, FALSE);
	purple_request_field_group_add_field(group, field);

	/* The UI fills this with the solved hCaptcha response token; discord_captcha_submit_cb
	 * reads it back on OK. */
	field = purple_request_field_string_new("captcha_key", _("Captcha Response"), "", FALSE);
	purple_request_field_string_set_editable(field, TRUE);
	purple_request_field_group_add_field(group, field);

	const gchar *username = purple_account_get_username(da->account);

	purple_request_fields(
		da->pc,                                     /* handle */
		_("Captcha Required"),                      /* title */
		_("Please complete the verification"),      /* primary */
		_("Discord requires a captcha to finish signing in"), /* secondary */
		fields,
		_("OK"), G_CALLBACK(discord_captcha_submit_cb),
		_("Dismiss"), G_CALLBACK(discord_null_cb),
		da->account,                                /* account -> transport keys it to this account */
		username,                                   /* username */
		NULL,                                       /* conversation */
		da                                          /* user_data -> discord_captcha_submit_cb */
	);
}

static void
discord_display_qrcode(PurpleConnection *pc, const gchar *qr_code_raw, const gchar *qrcode_utf8, const guchar *image_data, gsize image_data_len)
{
	DiscordAccount *da = purple_connection_get_protocol_data(pc);
	PurpleRequestUiOps *ui_ops = purple_request_get_ui_ops();

	/* webOS: imlibpurple installs no request UI ops (ui_ops == NULL) -> guard the
	 * deref and fall back to posting the QR/link as an IM ("Logon QR Code" chat). */
	if (!ui_ops || !ui_ops->request_fields) {
		/* webOS Messaging renders neither inline images nor a scannable ASCII QR,
		 * and the discord.com/ra/<fp> URL is NOT browser-openable (it only means
		 * something to the phone's Discord QR scanner). So the transport writes a
		 * real PNG QR to the photo gallery — point the user there to scan it. */
		gchar *msg_out = g_strdup_printf(
			"%s\n\n%s\n\n%s",
			_("A full-screen QR code should have opened. On your phone, open Discord "
			  "\342\206\222 Settings \342\206\222 Scan QR Code and scan the TouchPad screen."),
			_("If the QR window did not open, it is also saved to Photos as "
			  "\"discord-qr.png\"."),
			_("The code expires after about 2 minutes. If it does, disable and "
			  "re-enable the Discord account to get a fresh one."));

		purple_serv_got_im(pc, _("Logon QR Code"), msg_out, PURPLE_MESSAGE_RECV, time(NULL));

		g_free(msg_out);
		return;
	}

	PurpleRequestFields *fields = purple_request_fields_new();
	PurpleRequestFieldGroup *group = purple_request_field_group_new(NULL);
	purple_request_fields_add_group(fields, group);

	PurpleRequestField *field;
	field = purple_request_field_string_new("qr_string", _("QR Code Data"), qr_code_raw, FALSE);
	purple_request_field_string_set_editable(field, FALSE);
	purple_request_field_group_add_field(group, field);

	field = purple_request_field_image_new("qr_image", _("QR Code Image"), (const gchar *)image_data, image_data_len);
	purple_request_field_image_set_scale(field, 2, 2);
	purple_request_field_group_add_field(group, field);

	field = purple_request_field_string_new("qr_code", _("QR Code Data"), qrcode_utf8, TRUE);
	purple_request_field_string_set_editable(field, FALSE);
	purple_request_field_group_add_field(group, field);

	const gchar *username = purple_account_get_username(da->account);
	gchar *secondary = g_strdup_printf(_("Discord account %s"), username);

	purple_request_fields(
		da->pc, /*handle*/
		_("Logon QR Code"), /*title*/
		_("Please scan this QR code with your phone"), /*primary*/
		secondary, /*secondary*/
		fields, /*fields*/
		_("OK"), G_CALLBACK(discord_null_cb), /*OK*/
		_("Dismiss"), G_CALLBACK(discord_null_cb), /*Cancel*/
		da->account, /*account -- webOS: lets the transport key the QR to this account*/
		username, /*username*/
		NULL, /*conversation*/
		NULL /*data*/
	);
	
	g_free(secondary);
	
}

static gchar *
discord_base64_make_urlsafe(gchar *inout)
{
	// Basically - and _ replace + and /
	purple_util_chrreplace(inout, '+', '-');
	purple_util_chrreplace(inout, '/', '_');
	
	// Trim trailing =
	int i;
	for(i = strlen(inout) - 1; i >= 0; i--) {
		if(inout[i] == '=') {
			inout[i] = '\0';
		} else {
			break;
		}
	}
	
	return inout;
}



#include <qrencode.h>

// From qrencode/qrenc.c
static gchar * 
qrcode_utf8_output(const QRcode *qrcode)
{
	GString *out = g_string_new(NULL);
	int x, y;
	int realwidth;
	const int margin = 1;
	const char *empty, *lowhalf, *uphalf, *full;

	empty = "\342\200\202";
	lowhalf = "\342\226\204";
	uphalf = "\342\226\200";
	full = "\342\226\210";

	realwidth = (qrcode->width + margin * 2);

	/* top margin */
	for (x = 0; x < realwidth; x++) {
		g_string_append(out, full);
	}
	g_string_append_c(out, '\n');

	/* data */
	for(y = 0; y < qrcode->width; y += 2) {
		unsigned char *row1, *row2;
		row1 = qrcode->data + y*qrcode->width;
		row2 = row1 + qrcode->width;

		for (x = 0; x < margin; x++) {
			g_string_append(out, full);
		}

		for (x = 0; x < qrcode->width; x++) {
			if(row1[x] & 1) {
				if(y < qrcode->width - 1 && row2[x] & 1) {
					g_string_append(out, empty);
				} else {
					g_string_append(out, lowhalf);
				}
			} else if(y < qrcode->width - 1 && row2[x] & 1) {
				g_string_append(out, uphalf);
			} else {
				g_string_append(out, full);
			}
		}

		for (x = 0; x < margin; x++) {
			g_string_append(out, full);
		}

		g_string_append_c(out, '\n');
	}

	/* bottom margin */
	for (x = 0; x < realwidth; x++) {
		g_string_append(out, full);
	}

	return g_string_free(out, FALSE);;
}

// Based on the PNG output of qrencode/qrenc
static void 
qrcode_tga_fillRow(unsigned char *row, int num, const unsigned char color[])
{
	int i;

	for(i = 0; i < num; i++) {
		memcpy(row, color, 4);
		row += 4;
	}
}


static guchar * 
qrcode_tga_output(const QRcode *qrcode, gsize *out_len)
{
	GString *out = g_string_new(NULL);
	unsigned char *row, *p;
	int x, y, xx, yy;
	int realwidth, rowlen;
	const int margin = 1;
	const int size = 3;
	static unsigned char fg_color[4] = {0, 0, 0, 255};
	static unsigned char bg_color[4] = {255, 255, 255, 255};

	realwidth = (qrcode->width + margin * 2) * size;
	
	// From the telegram-purple plugin, which borrowed from pidgin-opensteamworks plugin
	const unsigned char tga_header[] = {
		// No ID; no color map; uncompressed true color
		0, 0, 2,
		// No color map metadata
		0, 0, 0, 0, 0,
		// No offsets
		0, 0, 0, 0,
		// Dimensions
		realwidth & 0xFF, (realwidth/256) & 0xFF, realwidth & 0xFF, (realwidth/256) & 0xFF,
		// 32 bits per pixel
		32,
		// "Origin in upper left-hand corner"
		32
	};
	g_string_append_len(out, (const gchar *)tga_header, sizeof(tga_header));
	
	rowlen = realwidth * 4;
	row = g_new(unsigned char, rowlen);
	
	if(row == NULL) {
		g_string_free(out, TRUE);
		if (out_len != NULL) {
			*out_len = 0;
		}
		return NULL;
	}

	/* top margin */
	qrcode_tga_fillRow(row, realwidth, bg_color);
	for(y = 0; y < margin * size; y++) {
		g_string_append_len(out, (const gchar *)row, rowlen);
	}

	/* data */
	p = qrcode->data;
	for(y = 0; y < qrcode->width; y++) {
		qrcode_tga_fillRow(row, realwidth, bg_color);
		for(x = 0; x < qrcode->width; x++) {
			for(xx = 0; xx < size; xx++) {
				if(*p & 1) {
					memcpy(&row[((margin + x) * size + xx) * 4], fg_color, 4);
				}
			}
			p++;
		}
		for(yy = 0; yy < size; yy++) {
			g_string_append_len(out, (const gchar *)row, rowlen);
		}
	}
	/* bottom margin */
	qrcode_tga_fillRow(row, realwidth, bg_color);
	for(y = 0; y < margin * size; y++) {
		g_string_append_len(out, (const gchar *)row, rowlen);
	}

	if (out_len != NULL) {
		*out_len = out->len;
	}
	return (guchar *)g_string_free(out, FALSE);
}

// webOS: neither inline images nor an ASCII QR render/scan in the Messaging app.
// Write a real grayscale PNG to the photo gallery instead; Photos renders it crisply
// and it scans fine off the TouchPad screen with the phone's Discord QR scanner.
#include <zlib.h>

#define DISCORD_QR_PNG_PATH "/media/internal/discord-qr.png"

static void
qrcode_png_chunk(GByteArray *out, const char *type, const guchar *data, gsize len)
{
	guchar lenb[4] = { (guchar)((len>>24)&0xFF), (guchar)((len>>16)&0xFF),
	                   (guchar)((len>>8)&0xFF),  (guchar)(len&0xFF) };
	g_byte_array_append(out, lenb, 4);
	gsize start = out->len;
	g_byte_array_append(out, (const guchar *)type, 4);
	if (data && len) {
		g_byte_array_append(out, data, len);
	}
	uLong crc = crc32(0L, Z_NULL, 0);
	crc = crc32(crc, out->data + start, 4 + len);
	guchar crcb[4] = { (guchar)((crc>>24)&0xFF), (guchar)((crc>>16)&0xFF),
	                   (guchar)((crc>>8)&0xFF),  (guchar)(crc&0xFF) };
	g_byte_array_append(out, crcb, 4);
}

// Encode the QR matrix to a scaled grayscale PNG (colour type 0, 8bpp) IN MEMORY.
// module_px = pixels per QR module, margin = quiet-zone width in modules.
// Returns a g_malloc'd PNG buffer (caller g_free's) and its length in *out_len,
// or NULL on failure. webOS: the transport forwards this to the accounts UI's inline
// QR <img> as a data URI -- PNG renders in the (old-WebKit) accounts webview; TGA does not.
static guchar *
qrcode_png_output(const QRcode *qrcode, int module_px, int margin, gsize *out_len)
{
	if (out_len) {
		*out_len = 0;
	}
	if (qrcode == NULL) {
		return NULL;
	}

	int qw = qrcode->width;
	int dim = (qw + margin * 2) * module_px;
	gsize rawrow = 1 + (gsize)dim;          /* 1 filter byte + dim pixel bytes */
	gsize rawtotal = rawrow * (gsize)dim;
	guchar *raw = g_malloc(rawtotal);

	for (int y = 0; y < dim; y++) {
		guchar *r = raw + (gsize)y * rawrow;
		r[0] = 0;                            /* filter type 0 (none) */
		int qy = y / module_px - margin;
		for (int x = 0; x < dim; x++) {
			int qx = x / module_px - margin;
			guchar px = 0xFF;                /* white */
			if (qx >= 0 && qx < qw && qy >= 0 && qy < qw &&
			    (qrcode->data[qy * qw + qx] & 1)) {
				px = 0x00;                   /* black module */
			}
			r[1 + x] = px;
		}
	}

	uLongf clen = compressBound(rawtotal);
	guchar *comp = g_malloc(clen);
	if (compress(comp, &clen, raw, rawtotal) != Z_OK) {
		g_free(raw);
		g_free(comp);
		return NULL;
	}
	g_free(raw);

	GByteArray *png = g_byte_array_new();
	static const guchar sig[8] = { 137, 80, 78, 71, 13, 10, 26, 10 };
	g_byte_array_append(png, sig, 8);

	guchar ihdr[13];
	ihdr[0] = (dim>>24)&0xFF; ihdr[1] = (dim>>16)&0xFF; ihdr[2] = (dim>>8)&0xFF; ihdr[3] = dim&0xFF;
	ihdr[4] = (dim>>24)&0xFF; ihdr[5] = (dim>>16)&0xFF; ihdr[6] = (dim>>8)&0xFF; ihdr[7] = dim&0xFF;
	ihdr[8] = 8;   /* bit depth */
	ihdr[9] = 0;   /* colour type: grayscale */
	ihdr[10] = 0;  /* compression */
	ihdr[11] = 0;  /* filter */
	ihdr[12] = 0;  /* interlace */
	qrcode_png_chunk(png, "IHDR", ihdr, 13);
	qrcode_png_chunk(png, "IDAT", comp, clen);
	qrcode_png_chunk(png, "IEND", NULL, 0);
	g_free(comp);

	guchar *result = (guchar *)g_memdup2(png->data, png->len);
	if (out_len) {
		*out_len = png->len;
	}
	g_byte_array_free(png, TRUE);
	return result;
}

// Convenience wrapper: encode to PNG (qrcode_png_output) and write it to `path`.
static gboolean
qrcode_png_write_file(const QRcode *qrcode, const char *path, int module_px, int margin)
{
	gsize len = 0;
	guchar *png = qrcode_png_output(qrcode, module_px, margin, &len);
	if (png == NULL) {
		return FALSE;
	}
	gboolean ok = g_file_set_contents(path, (const gchar *)png, len, NULL);
	g_free(png);
	return ok;
}

// webOS: pop the QR up full-screen automatically instead of making the user dig it
// out of the Photos app. The transport runs as root, so it can exec luna-send to
// launch our tiny viewer app (com.palm.app.discordqr) with the PNG path. Uses an
// explicit argv (no shell) to avoid any quoting pitfalls with the JSON payload.
static void
discord_launch_qr_viewer(const char *image_path)
{
	gchar *json = g_strdup_printf(
		"{\"id\":\"com.palm.app.discordqr\",\"params\":{\"image\":\"%s\"}}", image_path);
	gchar *argv[] = {
		(gchar *)"/usr/bin/luna-send", (gchar *)"-n", (gchar *)"1",
		(gchar *)"luna://com.palm.applicationManager/launch", json, NULL
	};
	g_spawn_async(NULL, argv, NULL,
	              (GSpawnFlags)(G_SPAWN_STDOUT_TO_DEV_NULL | G_SPAWN_STDERR_TO_DEV_NULL),
	              NULL, NULL, NULL, NULL);
	g_free(json);
}

static const guchar *
discord_sha256(guchar *data, gsize len)
{
	GChecksum *hash;
	static unsigned char sha256Hash[32];
	gsize sha256HashLen = sizeof(sha256Hash);
	
	hash = g_checksum_new(G_CHECKSUM_SHA256);
	g_checksum_update(hash, data, len);
	g_checksum_get_digest(hash, (guchar *)sha256Hash, &sha256HashLen);
	g_checksum_free(hash);
	
	return sha256Hash;
}

#ifdef USE_NSS_CRYPTO

#include <nss.h>
#include <keyhi.h>
#include <keythi.h>
#include <pk11pub.h>
#include <secdert.h>
#include <nssb64.h>


gboolean
discord_qrauth_generate_keys(DiscordAccount *da)
{
	SECKEYPrivateKey *prvKey = 0;
	SECKEYPublicKey *pubKey = 0;
	PK11SlotInfo *slot = 0;
	PK11RSAGenParams rsaParams;

	rsaParams.keySizeInBits = 2048;
	rsaParams.pe = 0x10001;

	slot = PK11_GetInternalKeySlot();
	if (!slot) { 
		return FALSE; 
	}

	prvKey = PK11_GenerateKeyPair(slot, CKM_RSA_PKCS_KEY_PAIR_GEN, &rsaParams, &pubKey, PR_FALSE, PR_FALSE, 0);

	if (slot) {
		PK11_FreeSlot(slot);
	}

	if (!prvKey) { 
		return FALSE; 
	}

	//store in DiscordAccount
	g_dataset_set_data(da, "pubkey", pubKey);
	g_dataset_set_data(da, "prvkey", prvKey);

	return TRUE;
}

void
discord_qrauth_free_keys(DiscordAccount *da)
{
	SECKEYPublicKey *pubKey = g_dataset_get_data(da, "pubkey");
	SECKEYPrivateKey *prvKey = g_dataset_get_data(da, "prvkey");
	
	if (pubKey) {
		SECKEY_DestroyPublicKey(pubKey);
		g_dataset_remove_data(da, "pubkey");
	}
	if (prvKey) {
		SECKEY_DestroyPrivateKey(prvKey);
		g_dataset_remove_data(da, "prvkey");
	}
}

gchar *
discord_qrauth_get_pubkey_base64(DiscordAccount *da)
{
	SECKEYPublicKey *pubKey = g_dataset_get_data(da, "pubkey");
	if (!pubKey) {
		return NULL;
	}

	SECItem *cert_der = PK11_DEREncodePublicKey(pubKey);
	
	// Can't use NSSBase64_EncodeItem as we need the base64 without whitespace
	gchar *b64crt = g_base64_encode(cert_der->data, cert_der->len);
	
	SECITEM_FreeItem(cert_der, PR_TRUE);
	
	
	return b64crt;
}

guchar *
discord_qrauth_decrypt(DiscordAccount *da, const gchar *encrypted_nonce, gsize *proof_len)
{
	SECKEYPublicKey *pubKey = g_dataset_get_data(da, "pubkey");
	SECKEYPrivateKey *prvKey = g_dataset_get_data(da, "prvkey");
	SECStatus rv = 0;
	unsigned char *out;
	unsigned int outlen;
	gsize nonce_len;
	guchar *nonce;
	
	if (!pubKey || !prvKey) {
		return NULL;
	}
	
	nonce = g_base64_decode(encrypted_nonce, &nonce_len);

	CK_RSA_PKCS_OAEP_PARAMS oaep_params;
	oaep_params.source = CKZ_DATA_SPECIFIED;
	oaep_params.pSourceData = NULL;
	oaep_params.ulSourceDataLen = 0;
	oaep_params.mgf = CKG_MGF1_SHA256;
	oaep_params.hashAlg = CKM_SHA256;
	
	SECItem param;
	param.type = siBuffer;
	param.data = (unsigned char*) &oaep_params;
	param.len = sizeof(oaep_params);
	
	out = g_new0(unsigned char, 20480);
	rv = PK11_PrivDecrypt(prvKey, CKM_RSA_PKCS_OAEP, &param, out, &outlen, 20480, nonce, nonce_len);
	if (rv != SECSuccess)
	{
		purple_debug_error("discord", "Decrypt with Private Key failed (err %d)\n", rv);
		if (proof_len != NULL) {
			*proof_len = 0;
		}
		return FALSE;
	}
	
	if (proof_len != NULL) {
		*proof_len = outlen;
	}
	return out;
}

#elif defined USE_GCRYPT_CRYPTO

#include <gcrypt.h>
#include <string.h>

// TODO

#elif defined USE_MBEDTLS_CRYPTO

#include "mbedtls/config.h"
#include "mbedtls/rsa.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"


// TODO

#elif defined USE_WIN32_CRYPTO

#include <windows.h>
#define _CRT_SECURE_NO_WARNINGS
#include <wincrypt.h>
#include <tchar.h>
#define SECURITY_WIN32
#include <security.h>

// TODO

#elif defined USE_OPENSSL_CRYPTO

#include <openssl/rsa.h>
#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/x509.h>

/* Discord "remote auth" (QR login) crypto, OpenSSL/EVP implementation.
 * Mirrors the NSS backend above: RSA-2048 keypair, SubjectPublicKeyInfo (SPKI)
 * DER public key base64 (i2d_PUBKEY), and RSA-OAEP with SHA-256 hash + MGF1-SHA256
 * private decrypt. Keypair stashed on the DiscordAccount via g_dataset. */

gboolean
discord_qrauth_generate_keys(DiscordAccount *da)
{
	EVP_PKEY *pkey = NULL;
	EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, NULL);

	if (!ctx) {
		return FALSE;
	}
	if (EVP_PKEY_keygen_init(ctx) <= 0 ||
	    EVP_PKEY_CTX_set_rsa_keygen_bits(ctx, 2048) <= 0 ||
	    EVP_PKEY_keygen(ctx, &pkey) <= 0) {
		EVP_PKEY_CTX_free(ctx);
		return FALSE;
	}
	EVP_PKEY_CTX_free(ctx);

	g_dataset_set_data(da, "evp_pkey", pkey);
	return TRUE;
}

void
discord_qrauth_free_keys(DiscordAccount *da)
{
	EVP_PKEY *pkey = g_dataset_get_data(da, "evp_pkey");
	if (pkey) {
		EVP_PKEY_free(pkey);
		g_dataset_remove_data(da, "evp_pkey");
	}
}

gchar *
discord_qrauth_get_pubkey_base64(DiscordAccount *da)
{
	EVP_PKEY *pkey = g_dataset_get_data(da, "evp_pkey");
	unsigned char *der = NULL;
	int derlen;
	gchar *b64;

	if (!pkey) {
		return NULL;
	}

	derlen = i2d_PUBKEY(pkey, &der);   /* SubjectPublicKeyInfo DER */
	if (derlen <= 0 || der == NULL) {
		return NULL;
	}

	b64 = g_base64_encode(der, derlen);
	OPENSSL_free(der);
	return b64;
}

guchar *
discord_qrauth_decrypt(DiscordAccount *da, const gchar *encrypted_nonce, gsize *proof_len)
{
	EVP_PKEY *pkey = g_dataset_get_data(da, "evp_pkey");
	EVP_PKEY_CTX *ctx = NULL;
	guchar *nonce = NULL;
	gsize nonce_len = 0;
	guchar *out = NULL;
	size_t outlen = 0;

	if (proof_len != NULL) {
		*proof_len = 0;
	}
	if (!pkey) {
		return NULL;
	}

	nonce = g_base64_decode(encrypted_nonce, &nonce_len);

	ctx = EVP_PKEY_CTX_new(pkey, NULL);
	if (!ctx ||
	    EVP_PKEY_decrypt_init(ctx) <= 0 ||
	    EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_OAEP_PADDING) <= 0 ||
	    EVP_PKEY_CTX_set_rsa_oaep_md(ctx, EVP_sha256()) <= 0 ||
	    EVP_PKEY_CTX_set_rsa_mgf1_md(ctx, EVP_sha256()) <= 0) {
		goto fail;
	}

	/* size the output buffer, then decrypt */
	if (EVP_PKEY_decrypt(ctx, NULL, &outlen, nonce, nonce_len) <= 0) {
		goto fail;
	}
	out = g_new0(guchar, outlen);
	if (EVP_PKEY_decrypt(ctx, out, &outlen, nonce, nonce_len) <= 0) {
		g_free(out);
		out = NULL;
		goto fail;
	}

	g_free(nonce);
	EVP_PKEY_CTX_free(ctx);
	if (proof_len != NULL) {
		*proof_len = outlen;
	}
	return out;

fail:
	purple_debug_error("discord", "OpenSSL RSA-OAEP decrypt failed\n");
	if (ctx) {
		EVP_PKEY_CTX_free(ctx);
	}
	g_free(nonce);
	return NULL;
}

#endif

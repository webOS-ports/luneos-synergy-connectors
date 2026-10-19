// Reference values for the MEGA tests, made with megajs 1.3.10 (MIT) by running its own functions
// (prepareKey, prepareKeyV2, AES.stringhash, packAttributes + getCipher().encryptCBC, MAC,
// CTR, mergeKeyMac, cryptoDecodePrivKey + cryptoRsaDecrypt, generateHashcashToken), lifted
// unchanged from dist/main.node-cjs.js into a vm. They are hard-coded so that the tests do not
// need megajs, and so that cloud/mega is checked against code it does not share. The RSA key
// was generated for this (node's generateKeyPairSync) and is used for nothing else.
//
// mac[].mac is megajs's meta-MAC. For a file whose size, rounded up to 16, ends on a chunk
// boundary (and for an empty one) megajs folds in one more, untouched block than MEGA's SDK and
// web client do; sdkMac holds what the old connector's own metaMacFile (fae7f10, its MAC on
// node's OpenSSL) computed for those sizes, which is the one MAC per chunk.
"use strict";

const crypto = require("node:crypto");

// The test data: sha256("<seed>:<i>") for i = 0, 1, .. concatenated, cut to n bytes.
function det(n, seed) {
	const out = [];
	for (let i = 0; out.length * 32 < n; i++) { out.push(crypto.createHash("sha256").update(seed + ":" + i).digest()); }
	return Buffer.concat(out).subarray(0, n);
}

const V = {
	"v1": [
		{
			"password": "correct horse battery staple",
			"email": "user@example.test",
			"pwKey": "57d978ef82e99ea50ab00045e8614d7b",
			"uh": "79HUi5bs474"
		},
		{
			"password": "pässwörd ✓ 日本",
			"email": "ünïcode@example.test",
			"pwKey": "36f06aa7df8a0e903811295be2fe84a8",
			"uh": "mXTw0_Oe1MA"
		},
		{
			"password": "",
			"email": "a@b.c",
			"pwKey": "93c467e37db0c7a4d1be3f810152cb56",
			"uh": "c8-0v2R4Dh0"
		},
		{
			"password": "exactly16bytes!!",
			"email": "x@y.z",
			"pwKey": "a8405e128bdb338f19f8c746fb8d600b",
			"uh": "bAjsTlMz7qY"
		}
	],
	"v2": [
		{
			"password": "correct horse battery staple",
			"salt": "_o2JzhPj4NyD6maY48nibX97yEG0KwkupGzPUfQ4514",
			"pwKey": "21814a185ddf11fdb7506037ea777ac2",
			"uh": "AJLVGNaxHqI36v-Padzigw"
		},
		{
			"password": "pässwörd ✓ 日本",
			"salt": "fzN1kpR4tQ8k0Z-vBtYIarm8eX-Cq6MysdM3EQ2NclA",
			"pwKey": "f57a2899e1221e3366bb64b7f3d5fb4a",
			"uh": "PEyXfCYzO4CG2nTqAtJ0AA"
		}
	],
	"attrs": [
		{
			"key": "00112233445566778899aabbccddeeff",
			"attrs": {
				"n": "Résumé – 2026 ✓"
			},
			"at": "zwwzn6zvBiGzO8MMSEa7Zgv4dlThbWNybjsFsOpc4NboPQ7XZ2J-P1wwkoSOgQDg"
		},
		{
			"key": "0f1e2d3c4b5a69788796a5b4c3d2e1f00123456789abcdeffedcba9876543210",
			"attrs": {
				"n": "photo.jpg",
				"c": "AbCdEfGhIjKlMnOpQrStUvWxYz0",
				"lbl": 3,
				"fav": 1
			},
			"at": "RkwXwK-KASZBp3NakJyYTP_y5c3S9gWg3xQ0CWMe71HRX-op3fqnjMWt6oBNSL9bGwdvXbrS_qUSK8TFEwJju7N-s_YdFYvvIn5AMOyf_fY"
		},
		{
			"key": "ffeeddccbbaa99887766554433221100",
			"attrs": {
				"n": "日本語のファイル名.txt"
			},
			"at": "_8Nl6A6-M6HCJKDlyIhHzDvwsc4fvvElFa4m_J2ryS-xlPh6VEUbipwHcMo37aUa"
		},
		{
			"key": "ffeeddccbbaa99887766554433221100",
			"attrs": {
				"n": "abcdefghijk"
			},
			"at": "_QCWcvvV3XkgesCq6C8q0ODL4t6n4lTpzng7fdu5W5o"
		}
	],
	"mac": [
		{
			"size": 1,
			"mac": "7caa0618ae9a4835",
			"ctSha256": "50868f20258bbc9cce0da2719e8654c108733dd2f663b8737c574ec0ead93eb3",
			"fullKey": "ERRTzQCshio2XLJ3uKbhTxqztAy8a8-PfKoGGK6aSDU"
		},
		{
			"size": 15,
			"mac": "1752b078c680a1e3",
			"ctSha256": "3d0883de03c8f0ecd6c851f195d774803c3f1c52e7da7232ec03cd3f8545e5ec",
			"fullKey": "ERRTzQCshipdpAQX0LwImRqztAy8a8-PF1KweMaAoeM"
		},
		{
			"size": 16,
			"mac": "0f1079da8abf39eb",
			"ctSha256": "33d5ea75b77bb60eb319452ac46c02b074acb9a03acd598212146228376a64e4",
			"fullKey": "ERRTzQCshipF5s21nIOQkRqztAy8a8-PDxB52oq_Oes"
		},
		{
			"size": 1000,
			"mac": "11dba24439d0fe7a",
			"ctSha256": "79f0beb5a0f6341badfb9af509f3f4062caf84a412d8c4a8b446e685141f0ba6",
			"fullKey": "ERRTzQCshipbLRYrL-xXABqztAy8a8-PEduiRDnQ_no"
		},
		{
			"size": 131071,
			"mac": "8c1c0dc70b8aa424",
			"ctSha256": "89c904f8a8489fa14c2a2793bf7a0006439aaee2ed0df95d363e71a2214c7b37",
			"fullKey": "ERRTzQCshirG6rmoHbYNXhqztAy8a8-PjBwNxwuKpCQ"
		},
		{
			"size": 131073,
			"mac": "cafae99a3c613e46",
			"ctSha256": "3d18219fe119ea0b5c2aff4e3fd7a93ac4704465e2497c873456e6b25a53fc50",
			"fullKey": "ERRTzQCshiqADF31Kl2XPBqztAy8a8-PyvrpmjxhPkY"
		},
		{
			"size": 300000,
			"mac": "98253ac413bea231",
			"ctSha256": "4523c2ead50430b26a04f03f71ea15b2d7e5fa8f984a0706bb57b91932398231",
			"fullKey": "ERRTzQCshirS046rBYILSxqztAy8a8-PmCU6xBO-ojE"
		},
		{
			"size": 393217,
			"mac": "a81d6d2ed2f9e7e8",
			"ctSha256": "d674fd233b596782e22ec1083fbe70c6a7ceb010e41d0190b974d9261ec11a1b",
			"fullKey": "ERRTzQCshiri69lBxMVOkhqztAy8a8-PqB1tLtL55-g"
		},
		{
			"size": 1500000,
			"mac": "0c9fb71a7603ca50",
			"ctSha256": "0a7b07ca3e2b649803ab02796b192fb3045a4fa33a47a3c811d9b39f60f614cf",
			"fullKey": "ERRTzQCshipGaQN1YD9jKhqztAy8a8-PDJ-3GnYDylA"
		},
		{
			"size": 131072,
			"mac": "20e7febd8b6830b8",
			"ctSha256": "05d205005ce098b03848c5e6bbea3cfa63a9bc322434b13195a24edf4a40bb9c",
			"fullKey": "ERRTzQCshipqEUrSnVSZwhqztAy8a8-PIOf-vYtoMLg"
		},
		{
			"size": 393216,
			"mac": "75080915f1158405",
			"ctSha256": "64fb4af928f8b98bcf24a7a88b626ce9f6f656f88bc8362acebde8eb18bb516c",
			"fullKey": "ERRTzQCshio__r165yktfxqztAy8a8-PdQgJFfEVhAU"
		}
	],
	"fileKey24": "0ba7e7c1bcc749a54af6b46f163ca97a1ab3b40cbc6bcf8f",
	"rsa": {
		"privk": "0400dc73d133bbc5cef3c92d77767cb4ba3db117160aa6d1c0dec110d6951c1cd11ea1761cffcaa1aeac0c283b8af4242027979eda18bf35b002445c10f64f22ab2b868809ff3c5bc9eecdeaabf6fef89b2bc2c37ecc2f60178e607f401ceb19b71c2faa2033da42082f9d7fd8e40d3098cfaf36c81bdb79979f0ffd8b5f5242231d0400e5dfd7519dddb41472fa63688fb53eea4a2ad5fea602282e7de52de23274e561a2d4f4460af080ae2f1fe545012f643cbd3420c1c603c6a5aa0dc8ec38a63c900bf3b96fd2b48d6c27b25150dedc4310a3cd7addbdba689c66b46a1b0d93ca8950c61edcc2b32d2b8a2dc08eb6d89db670464b5fcec36c16ef83c4fccd2d0a4507f75857f5e9f1deb22bda97669950fa25c558bb45c0f99059282d4bf1ebf564dd93149f91306d0ced6440d83f6a8342c146a3806b304c47cf2cd206f2fbf9787c3a959d48a497790222812212b7373ae6f990c350043d238ed243da824d744815889a9f2cccb2b17bf524e60ea1d41eba0e8f2d004fc033e20c31552feed909d0682159803c22f2c5af5ca616e78b8aafd4c3503cab5d1940c7fa981cb8eb4021f5b568df60df23e5a7597783323efaefb5447deee4b0c058f747f628e05c10078efbced7b8b495735d544cbc118a32fb68c0f9b8d17c13d0a09cc9cea5b9fc5a952f7292ced73f4d222799089f8dd31302a1347782dd5339b564cea29d21f2bd04008fc536a9bc3cdaed0edf2f720f0af88f9340ebad52eaa97f535fe3aa52ba79467c0a4d992341b85c6c568202ab296c73d94ef5d77150164614ccbcf0d41bcda12fde27896be643ffaa8f0cd57997fa4abb6e3490ddc139f4e78e17b16bd3224ec28f7a6b07e0289b5854c760dc923cfda2c6eec98903c84df4961e9b83ba6b05000000000000000000",
		"csid": "B_9WbUHLMA8GAMtRvFSLagXRc1usNy5OHuTCt86oxFC8bV2Or_pbajMvaeoiBZKfYNYm-wiuqxWbGzauxvoehbRmiFLj2Yp_8l_kyiOVG4BYnhiJFbJrx9BplQcq2nKWlzg_EUnmgPTtOpZRZUlOiasVxeteHLeL6KbeGsv24h77NA-y8qvc2F-Jv8sRgjBBuiKNK4Y-wvWZI6mdo3u1W956fRyl6bJw1ltn5FslR2-WSFzxqi_MZQsxezDhQTjoFqsjEpZxSAdcPoSu_bf_eckn9bhrevQvmC0l629PVX_zeTgIhhCpwMd5Z28jZC-9w_cIypATRNJk3tGy3BOx4pU2",
		"sid": "WoCpujWXvq8tU90Of85SC2hldJCJDS15uBeVhV0fq8B21uF6qtiqO32gKA",
		"n": "c5f45c72105219dc42b0772efb20f82732fb39aa4988d8b8ea0c98db5f6084217d5cc2854e66be546e52e87f2ee407ecb73d300a919390fc5e9002442b97b79fce5a73f8ffb2eb83ab7421458c7b80bd4450645661d19c3323aed41890b6b3f6569d7961bf00f7ef7b7a024f49f2ae0cf6ff934c3034f4cc12c7273f60d89721907c48eb9c266366a5189f0d48cad7d2298405c4105e88fe14ab2877606f1900c05c0dff3d3ec2c6e5d8581332c7e1cd8a7d29a6b37ba632952ee667e53287a76f741786b1a374edcad91245ae41975623163e1a6c96f880e1e6bdae3e7011346f2415106bc945e4dc032b07689c4428787a7dd727e93099b23c7a32264b98d1",
		"e": "10001"
	},
	"hashcash": {
		"challenge": "1:255:1792400357:VUgzITo0LLV7EQpB5HGGg2Gb8ozgZUwRvfCcjTgA1QPWyeNPGrn-HD21KRMFF22k",
		"answer": "1:VUgzITo0LLV7EQpB5HGGg2Gb8ozgZUwRvfCcjTgA1QPWyeNPGrn-HD21KRMFF22k:AQAAAA"
	}
};

V.sdkMac = {
	"0": "0000000000000000",
	"131071": "f9b874a69ac68c54",
	"131072": "066b74a8f886166b",
	"300000": "98253ac413bea231",
	"393216": "c1e86bc62bf53d4f"
};

module.exports = Object.assign(V, { det });

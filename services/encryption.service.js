// services/encryption.service.js
const crypto = require('crypto');

class EncryptionService {
    constructor(publicKeyPem) {
        this.publicKey = publicKeyPem;
    }

    encrypt(data) {
        try {
            const buffer = Buffer.from(data, 'utf8');
            const encrypted = crypto.publicEncrypt(
                {
                    key: this.publicKey,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: 'sha256'
                },
                buffer
            );
            return encrypted.toString('base64');
        } catch (error) {
            console.error('Encryption error:', error);
            throw new Error(`Failed to encrypt: ${error.message}`);
        }
    }

    static generateConversationId() {
        return `conv_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    }

    static generateTransactionReference() {
        return `TXN${Date.now()}`.substring(0, 20);
    }

    static generatePaymentSessionId() {
        return `PAY_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    }
}

module.exports = EncryptionService;

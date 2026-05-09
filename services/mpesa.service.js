// services/mpesa.service.js
const axios = require('axios');
const EncryptionService = require('./encryption.service');
require('dotenv').config();

class MpesaService {
    constructor() {
        this.apiKey = process.env.MPESA_API_KEY;
        this.publicKeyPem = process.env.MPESA_PUBLIC_KEY;
        this.encryptionService = new EncryptionService(this.publicKeyPem);
        this.baseUrl = process.env.MPESA_API_URL;
        this.market = process.env.MPESA_MARKET;
        this.country = process.env.MPESA_COUNTRY;
        this.currency = process.env.MPESA_CURRENCY;
        this.serviceProviderCode = process.env.MPESA_SERVICE_PROVIDER_CODE;
        this.environment = process.env.MPESA_ENVIRONMENT;
    }

    async generateSessionKey() {
        const path = this.environment === 'sandbox' 
            ? `/sandbox/ipg/v2/${this.market}/getSession/`
            : `/openapi/ipg/v2/${this.market}/getSession/`;

        const url = `${this.baseUrl}${path}`;
        const encryptedApiKey = this.encryptionService.encrypt(this.apiKey);

        console.log('🔄 Generating M-Pesa session...');

        try {
            const response = await axios({
                method: 'GET',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${encryptedApiKey}`,
                    'Origin': process.env.CALLBACK_URL_BASE || '*'
                },
                timeout: parseInt(process.env.REQUEST_TIMEOUT_MS) || 60000
            });

            const sessionId = response.data.output_SessionID;
            const encryptedSessionKey = this.encryptionService.encrypt(sessionId);

            return { sessionId, encryptedSessionKey };
        } catch (error) {
            console.error('Session generation failed:', error.response?.data || error.message);
            throw new Error(`M-Pesa session failed: ${error.message}`);
        }
    }

    async initiateC2BPayment(paymentData) {
        const { encryptedSessionKey, sessionId } = await this.generateSessionKey();

        console.log(`⏳ Waiting ${process.env.SESSION_SLEEP_MS / 1000}s for session...`);
        await new Promise(resolve => setTimeout(resolve, parseInt(process.env.SESSION_SLEEP_MS) || 30000));

        const path = this.environment === 'sandbox'
            ? `/sandbox/ipg/v2/${this.market}/c2bPayment/singleStage/`
            : `/openapi/ipg/v2/${this.market}/c2bPayment/singleStage/`;

        const url = `${this.baseUrl}${path}`;

        const requestBody = {
            input_Amount: paymentData.amount.toString(),
            input_Country: this.country,
            input_Currency: this.currency,
            input_CustomerMSISDN: paymentData.phoneNumber,
            input_ServiceProviderCode: this.serviceProviderCode,
            input_ThirdPartyConversationID: paymentData.conversationId,
            input_TransactionReference: paymentData.transactionReference,
            input_PurchasedItemsDesc: paymentData.description || 'ZAS Wallet Deposit'
        };

        console.log('📤 Sending payment request to M-Pesa...');

        try {
            const response = await axios({
                method: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${encryptedSessionKey}`,
                    'Origin': process.env.CALLBACK_URL_BASE || '*'
                },
                data: requestBody,
                timeout: parseInt(process.env.REQUEST_TIMEOUT_MS) || 60000
            });

            const result = response.data;
            const isSuccess = result.output_ResponseCode === 'INS-0';

            return {
                success: isSuccess,
                responseCode: result.output_ResponseCode,
                responseDesc: result.output_ResponseDesc,
                transactionId: result.output_TransactionID,
                conversationId: result.output_ConversationID,
                thirdPartyConversationId: result.output_ThirdPartyConversationID,
                sessionId: sessionId
            };
        } catch (error) {
            console.error('Payment failed:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data || error.message
            };
        }
    }
}

module.exports = new MpesaService();

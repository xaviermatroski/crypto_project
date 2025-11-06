const axios = require('axios');
const FormData = require('form-data');

// Get the NestJS backend URL from environment variables or use a default
const NESTJS_BACKEND_URL = process.env.NESTJS_URL || 'http://localhost:3000';

/**
 * Uploads a file to the NestJS (Fabric/MinIO) backend.
 *
 * @param {Express.Multer.File} file - The file object from multer.
 * @param {string} caseId - The MongoDB case ID.
 * @param {string} orgMspId - The user's org (e.g., 'Org1MSP').
 * @param {string} recordType - The type of record (e.g., 'Evidence').
 * @param {string} policyId - The policy ID to apply.
 * @returns {string} The new Fabric recordId.
 */
async function uploadDocumentToBlockchain(file, caseId, orgMspId, recordType, policyId) {
  try {
    // Create FormData to send the file
    const formData = new FormData();
    formData.append('file', file.buffer, file.originalname);
    formData.append('caseId', caseId);
    formData.append('recordType', recordType);
    if (policyId) {
      formData.append('policyId', policyId);
    }

    // Call the NestJS API, passing the orgMspId as a query parameter
    const response = await axios.post(
      `${NESTJS_BACKEND_URL}/records?org=${orgMspId}`,
      formData,
      {
        headers: {
          ...formData.getHeaders()
        }
      }
    );

    // Return the new recordId from the response
    if (response.data && response.data.recordId) {
      return response.data.recordId;
    } else {
      throw new Error('Backend did not return a recordId.');
    }
  } catch (error) {
    console.error(`Blockchain Upload Error for ${file.originalname}:`, error.message);
    throw new Error(`Failed to upload ${file.originalname} to blockchain.`);
  }
}

/**
 * Downloads a file from the NestJS (Fabric/MinIO) backend.
 *
 * @param {string} recordId - The Fabric recordId to fetch.
 * @param {string} orgMspId - The user's org (e.g., 'Org1MSP').
 * @returns {Buffer} The decrypted file buffer.
 */
async function downloadDocumentFromBlockchain(recordId, orgMspId) {
  try {
    // Call the NestJS API
    const response = await axios.get(
      `${NESTJS_BACKEND_URL}/records/${recordId}?org=${orgMspId}`,
      {
        responseType: 'arraybuffer' // Get the file as a buffer
      }
    );
    return response.data;
  } catch (error) {
    console.error(`Blockchain Download Error for ${recordId}:`, error.message);
    if (error.response && error.response.status === 403) {
      throw new Error('Access Denied by Blockchain Policy');
    }
    throw new Error(`Failed to download document ${recordId} from blockchain.`);
  }
}

module.exports = {
  uploadDocumentToBlockchain,
  downloadDocumentFromBlockchain
};
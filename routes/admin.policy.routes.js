const axios = require('axios');
const FormData = require('form-data');

const NESTJS_BACKEND_URL = process.env.NESTJS_URL || 'http://localhost:3000';

/**
 * Upload a document to the NestJS (Fabric/MinIO) backend.
 */
async function uploadDocumentToBlockchain(file, caseId, orgMspId, recordType, policyId) {
  try {
    const formData = new FormData();
    formData.append('file', file.buffer, file.originalname);
    formData.append('caseId', caseId.toString());
    formData.append('recordType', recordType.toString());
    if (policyId) formData.append('policyId', policyId.toString());

    const response = await axios.post(
      `${NESTJS_BACKEND_URL}/records?org=${orgMspId}`,
      formData,
      { headers: { ...formData.getHeaders() } }
    );

    if (response.data && response.data.recordId) {
      return response.data.recordId;
    } else {
      throw new Error('Backend did not return a recordId.');
    }
  } catch (error) {
    console.error(`Blockchain Upload Error for ${file.originalname}:`, error.message);
    const backendError = error.response?.data?.message || error.message;
    throw new Error(`Failed to upload ${file.originalname}: ${backendError}`);
  }
}

/**
 * Download a document from the NestJS (Fabric/MinIO) backend.
 */
async function downloadDocumentFromBlockchain(recordId, orgMspId) {
  try {
    const response = await axios.get(
      `${NESTJS_BACKEND_URL}/records/${recordId}?org=${orgMspId}`,
      { responseType: 'arraybuffer' }
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

/**
 * Create a new policy on the blockchain via the NestJS backend.
 * 🔧 Fixed: Ensures proper JSON serialization before sending to Fabric backend.
 */
async function createPolicyOnBlockchain(policyId, categories, rules, orgMspId) {
  try {
    // ------------------- CHANGE IS HERE -------------------
    // This payload now matches your working Postman request.
    const payload = {
      policyId: policyId?.toString(),
      categories: categories || [], // Use 'categories' key, pass array directly
      rules: rules || []           // Use 'rules' key, pass array directly
    };
    // ----------------- END OF CHANGE ------------------

    const response = await axios.post(
      `${NESTJS_BACKEND_URL}/records/policies`, // The API endpoint
      payload,                                 // The corrected request body
      { params: { org: orgMspId?.toString() } } // orgMspId as query param
    );

    return response.data;
  } catch (error) {
    console.error(`Blockchain Policy Create Error for ${policyId}:`, error.message);
    const backendError = error.response?.data?.message || error.message;
    throw new Error(`Failed to create policy ${policyId}: ${backendError}`);
  }
}

module.exports = {
  uploadDocumentToBlockchain,
  downloadDocumentFromBlockchain,
  createPolicyOnBlockchain
};

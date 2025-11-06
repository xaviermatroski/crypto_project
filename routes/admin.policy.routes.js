const axios = require('axios');
const FormData = require('form-data');

const NESTJS_BACKEND_URL = process.env.NESTJS_URL || 'http://localhost:3000';

/**
 * Uploads a file to the NestJS (Fabric/MinIO) backend.
 */
async function uploadDocumentToBlockchain(file, caseId, orgMspId, recordType, policyId) {
  try {
    const formData = new FormData();
    formData.append('file', file.buffer, file.originalname);
    formData.append('caseId', caseId);
    formData.append('recordType', recordType);
    if (policyId) {
      formData.append('policyId', policyId);
    }

    const response = await axios.post(
      `${NESTJS_BACKEND_URL}/records?org=${orgMspId}`,
      formData,
      {
        headers: {
          ...formData.getHeaders()
        }
      }
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
 * Downloads a file from the NestJS (Fabric/MinIO) backend.
 */
async function downloadDocumentFromBlockchain(recordId, orgMspId) {
  try {
    const response = await axios.get(
      `${NESTJS_BACKEND_URL}/records/${recordId}?org=${orgMspId}`,
      {
        responseType: 'arraybuffer'
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

/**
 * Creates a new policy on the blockchain via the NestJS backend.
 */
async function createPolicyOnBlockchain(policyId, categoriesJSON, rulesJSON, orgMspId) {
  try {
    // This calls the POST /records/policies endpoint on your Nest backend
    const response = await axios.post(
      `${NESTJS_BACKEND_URL}/records/policies`,
      {
        policyId: policyId,
        categoriesJSON: categoriesJSON,
        rulesJSON: rulesJSON
      },
      {
        // We pass the orgMspId as a query param
        params: {
          org: orgMspId 
        }
      }
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
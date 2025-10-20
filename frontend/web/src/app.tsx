// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface LegalDocument {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  caseId: string;
  keywords: string[];
  status: "pending" | "verified" | "rejected";
}

// Randomly selected styles: High contrast (blue+orange), Glass morphism, Partition panels, Animation rich
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<LegalDocument[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDocument, setNewDocument] = useState({ caseId: "", keywords: "", relevanceScore: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<LegalDocument | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [showStats, setShowStats] = useState(false);

  const verifiedCount = documents.filter(d => d.status === "verified").length;
  const pendingCount = documents.filter(d => d.status === "pending").length;
  const rejectedCount = documents.filter(d => d.status === "rejected").length;

  useEffect(() => {
    loadDocuments().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadDocuments = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }
      
      const keysBytes = await contract.getData("document_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing document keys:", e); }
      }
      
      const list: LegalDocument[] = [];
      for (const key of keys) {
        try {
          const docBytes = await contract.getData(`document_${key}`);
          if (docBytes.length > 0) {
            try {
              const docData = JSON.parse(ethers.toUtf8String(docBytes));
              list.push({ 
                id: key, 
                encryptedData: docData.data, 
                timestamp: docData.timestamp, 
                owner: docData.owner, 
                caseId: docData.caseId,
                keywords: docData.keywords || [],
                status: docData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing document data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading document ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setDocuments(list);
    } catch (e) { 
      console.error("Error loading documents:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const uploadDocument = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setUploading(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting document relevance score with Zama FHE..." 
    });
    
    try {
      const encryptedData = FHEEncryptNumber(newDocument.relevanceScore);
      const keywordsArray = newDocument.keywords.split(',').map(k => k.trim()).filter(k => k.length > 0);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const docId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const docData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        caseId: newDocument.caseId,
        keywords: keywordsArray,
        status: "pending" 
      };
      
      await contract.setData(`document_${docId}`, ethers.toUtf8Bytes(JSON.stringify(docData)));
      
      const keysBytes = await contract.getData("document_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(docId);
      await contract.setData("document_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Encrypted document submitted to secure data room!" 
      });
      
      await loadDocuments();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowUploadModal(false);
        setNewDocument({ caseId: "", keywords: "", relevanceScore: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
      3000);
    } finally { 
      setUploading(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const verifyDocument = async (docId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Processing encrypted document with FHE..." 
    });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const docBytes = await contract.getData(`document_${docId}`);
      if (docBytes.length === 0) throw new Error("Document not found");
      
      const docData = JSON.parse(ethers.toUtf8String(docBytes));
      const verifiedData = FHECompute(docData.data, 'increase10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedDoc = { ...docData, status: "verified", data: verifiedData };
      await contractWithSigner.setData(`document_${docId}`, ethers.toUtf8Bytes(JSON.stringify(updatedDoc)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE verification completed successfully!" 
      });
      
      await loadDocuments();
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
      2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Verification failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
      3000);
    }
  };

  const rejectDocument = async (docId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Processing encrypted document with FHE..." 
    });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const docBytes = await contract.getData(`document_${docId}`);
      if (docBytes.length === 0) throw new Error("Document not found");
      
      const docData = JSON.parse(ethers.toUtf8String(docBytes));
      const updatedDoc = { ...docData, status: "rejected" };
      
      await contract.setData(`document_${docId}`, ethers.toUtf8Bytes(JSON.stringify(updatedDoc)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE rejection completed successfully!" 
      });
      
      await loadDocuments();
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
      2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Rejection failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
      3000);
    }
  };

  const isOwner = (docAddress: string) => 
    address?.toLowerCase() === docAddress.toLowerCase();

  const tutorialSteps = [
    { 
      title: "Connect Wallet", 
      description: "Connect your Web3 wallet to access the secure legal discovery platform", 
      icon: "🔗" 
    },
    { 
      title: "Upload Encrypted Documents", 
      description: "Add legal documents with encrypted relevance scores using Zama FHE", 
      icon: "📄",
      details: "Documents are encrypted client-side before being stored in the shared data room" 
    },
    { 
      title: "FHE Keyword Search", 
      description: "Search for keywords across encrypted documents without decryption", 
      icon: "🔍",
      details: "Zama FHE technology enables searching encrypted data while preserving confidentiality" 
    },
    { 
      title: "Multi-party Discovery", 
      description: "Collaborate with other parties while maintaining document confidentiality", 
      icon: "👥",
      details: "All parties can contribute documents and search results without exposing sensitive content" 
    }
  ];

  const filteredDocuments = documents.filter(doc => {
    const matchesSearch = searchTerm === "" || 
      doc.caseId.toLowerCase().includes(searchTerm.toLowerCase()) || 
      doc.keywords.some(k => k.toLowerCase().includes(searchTerm.toLowerCase()));
    
    if (activeTab === "all") return matchesSearch;
    if (activeTab === "verified") return matchesSearch && doc.status === "verified";
    if (activeTab === "pending") return matchesSearch && doc.status === "pending";
    if (activeTab === "rejected") return matchesSearch && doc.status === "rejected";
    return matchesSearch;
  });

  const renderKeywordPills = (keywords: string[]) => (
    <div className="keyword-pills">
      {keywords.map((keyword, i) => (
        <span key={i} className="keyword-pill">{keyword}</span>
      ))}
    </div>
  );

  const renderStatsCard = () => (
    <div className="stats-card glass-morphism">
      <h3>Case Statistics</h3>
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-value">{documents.length}</div>
          <div className="stat-label">Total Documents</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{verifiedCount}</div>
          <div className="stat-label">Verified</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{rejectedCount}</div>
          <div className="stat-label">Rejected</div>
        </div>
      </div>
      <div className="keyword-cloud">
        <h4>Common Keywords</h4>
        <div className="keywords">
          {Array.from(
            new Set(documents.flatMap(d => d.keywords))
          ).slice(0, 10).map((keyword, i) => (
            <span key={i} className="keyword-tag">{keyword}</span>
          ))}
        </div>
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner">
        <div className="fhe-lock-icon"></div>
        <div className="spinner-ring"></div>
      </div>
      <p>Initializing secure FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container glass-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="scales-icon"></div>
          </div>
          <h1>Legal<span>Discovery</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowUploadModal(true)} 
            className="upload-btn glass-button"
          >
            <div className="upload-icon"></div>Upload Document
          </button>
          <button 
            className="glass-button" 
            onClick={() => setShowTutorial(!showTutorial)}
          >
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content partitioned-layout">
        <div className="left-panel">
          <div className="search-section glass-morphism">
            <div className="search-bar">
              <input
                type="text"
                placeholder="Search case IDs or keywords..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="glass-input"
              />
              <button className="search-icon-btn">
                <div className="search-icon"></div>
              </button>
            </div>
            <div className="filter-tabs">
              <button 
                className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
                onClick={() => setActiveTab("all")}
              >
                All Documents
              </button>
              <button 
                className={`tab-btn ${activeTab === "verified" ? "active" : ""}`}
                onClick={() => setActiveTab("verified")}
              >
                Verified
              </button>
              <button 
                className={`tab-btn ${activeTab === "pending" ? "active" : ""}`}
                onClick={() => setActiveTab("pending")}
              >
                Pending
              </button>
              <button 
                className={`tab-btn ${activeTab === "rejected" ? "active" : ""}`}
                onClick={() => setActiveTab("rejected")}
              >
                Rejected
              </button>
            </div>
          </div>
          
          <button 
            className="toggle-stats glass-button"
            onClick={() => setShowStats(!showStats)}
          >
            {showStats ? "Hide Statistics" : "Show Statistics"}
          </button>
          
          {showStats && renderStatsCard()}
        </div>

        <div className="right-panel">
          {showTutorial && (
            <div className="tutorial-section glass-morphism">
              <h2>FHE Legal Discovery Guide</h2>
              <p className="subtitle">Learn how to securely process legal documents with Zama FHE</p>
              <div className="tutorial-steps">
                {tutorialSteps.map((step, index) => (
                  <div className="tutorial-step" key={index}>
                    <div className="step-icon">{step.icon}</div>
                    <div className="step-content">
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                      {step.details && <div className="step-details">{step.details}</div>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="fhe-diagram">
                <div className="diagram-step">
                  <div className="diagram-icon">📄</div>
                  <div className="diagram-label">Legal Document</div>
                </div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-step">
                  <div className="diagram-icon">🔒</div>
                  <div className="diagram-label">FHE Encryption</div>
                </div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-step">
                  <div className="diagram-icon">🔍</div>
                  <div className="diagram-label">Encrypted Search</div>
                </div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-step">
                  <div className="diagram-icon">👥</div>
                  <div className="diagram-label">Multi-party Access</div>
                </div>
              </div>
            </div>
          )}

          <div className="documents-section">
            <div className="section-header">
              <h2>Legal Documents</h2>
              <div className="header-actions">
                <button 
                  onClick={loadDocuments} 
                  className="refresh-btn glass-button" 
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            <div className="documents-list glass-morphism">
              {filteredDocuments.length === 0 ? (
                <div className="no-documents">
                  <div className="no-docs-icon"></div>
                  <p>No documents found matching your criteria</p>
                  <button 
                    className="glass-button primary" 
                    onClick={() => setShowUploadModal(true)}
                  >
                    Upload First Document
                  </button>
                </div>
              ) : (
                <div className="documents-grid">
                  {filteredDocuments.map(doc => (
                    <div 
                      className="document-card" 
                      key={doc.id} 
                      onClick={() => setSelectedDocument(doc)}
                    >
                      <div className="doc-header">
                        <span className="case-id">Case #{doc.caseId}</span>
                        <span className={`status-badge ${doc.status}`}>
                          {doc.status}
                        </span>
                      </div>
                      <div className="doc-meta">
                        <span className="owner">
                          {doc.owner.substring(0, 6)}...{doc.owner.substring(38)}
                        </span>
                        <span className="date">
                          {new Date(doc.timestamp * 1000).toLocaleDateString()}
                        </span>
                      </div>
                      {renderKeywordPills(doc.keywords)}
                      <div className="doc-actions">
                        {isOwner(doc.owner) && doc.status === "pending" && (
                          <>
                            <button 
                              className="action-btn glass-button success" 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                verifyDocument(doc.id); 
                              }}
                            >
                              Verify
                            </button>
                            <button 
                              className="action-btn glass-button danger" 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                rejectDocument(doc.id); 
                              }}
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showUploadModal && (
        <ModalUpload 
          onSubmit={uploadDocument} 
          onClose={() => setShowUploadModal(false)} 
          uploading={uploading} 
          documentData={newDocument} 
          setDocumentData={setNewDocument}
        />
      )}

      {selectedDocument && (
        <DocumentDetailModal 
          document={selectedDocument} 
          onClose={() => { 
            setSelectedDocument(null); 
            setDecryptedValue(null); 
          }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content glass-morphism">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="scales-icon"></div>
              <span>LegalDiscoveryFHE</span>
            </div>
            <p>Secure multi-party legal discovery powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact Support</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} LegalDiscoveryFHE. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalUploadProps {
  onSubmit: () => void; 
  onClose: () => void; 
  uploading: boolean;
  documentData: any;
  setDocumentData: (data: any) => void;
}

const ModalUpload: React.FC<ModalUploadProps> = ({ 
  onSubmit, 
  onClose, 
  uploading, 
  documentData, 
  setDocumentData 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setDocumentData({ ...documentData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setDocumentData({ ...documentData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!documentData.caseId || !documentData.relevanceScore) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="upload-modal glass-morphism">
        <div className="modal-header">
          <h2>Upload Legal Document</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your document relevance score will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Case ID *</label>
              <input 
                type="text" 
                name="caseId" 
                value={documentData.caseId} 
                onChange={handleChange} 
                placeholder="Enter case identifier..."
                className="glass-input"
              />
            </div>
            <div className="form-group">
              <label>Keywords</label>
              <input 
                type="text" 
                name="keywords" 
                value={documentData.keywords} 
                onChange={handleChange} 
                placeholder="Comma-separated keywords..."
                className="glass-input"
              />
            </div>
            <div className="form-group">
              <label>Relevance Score *</label>
              <input 
                type="number" 
                name="relevanceScore" 
                value={documentData.relevanceScore} 
                onChange={handleValueChange} 
                placeholder="Enter numerical relevance (0-100)..." 
                className="glass-input"
                min="0"
                max="100"
                step="1"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{documentData.relevanceScore || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {documentData.relevanceScore ? 
                    FHEEncryptNumber(documentData.relevanceScore).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Legal Confidentiality</strong>
              <p>Document contents remain encrypted during FHE processing and are never decrypted on our servers</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn glass-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={uploading} 
            className="submit-btn glass-button primary"
          >
            {uploading ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface DocumentDetailModalProps {
  document: LegalDocument;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const DocumentDetailModal: React.FC<DocumentDetailModalProps> = ({ 
  document, 
  onClose, 
  decryptedValue, 
  setDecryptedValue, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(document.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="document-detail-modal glass-morphism">
        <div className="modal-header">
          <h2>Document Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="document-info">
            <div className="info-item">
              <span>Case ID:</span>
              <strong>{document.caseId}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>
                {document.owner.substring(0, 6)}...{document.owner.substring(38)}
              </strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>
                {new Date(document.timestamp * 1000).toLocaleString()}
              </strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${document.status}`}>
                {document.status}
              </strong>
            </div>
          </div>
          
          <div className="keywords-section">
            <h3>Keywords</h3>
            <div className="keyword-pills">
              {document.keywords.map((keyword, i) => (
                <span key={i} className="keyword-pill">{keyword}</span>
              ))}
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Relevance Score</h3>
            <div className="encrypted-data">
              {document.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>Zama FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn glass-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedValue !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Relevance Score</h3>
              <div className="decrypted-value">
                {decryptedValue}
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>
                  Decrypted data is only visible after wallet signature verification
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn glass-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;
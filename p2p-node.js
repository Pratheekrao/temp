// p2p-node.js
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const os = require('os');

const app = express();
const PORT = process.env.NODE_PORT || 3000;
const NODE_NAME = process.env.NODE_NAME || os.hostname();

// Persistent storage paths
const STORAGE_DIR = 'persistent-data';
const METADATA_FILE = path.join(STORAGE_DIR, 'file-metadata.json');
const PEERS_FILE = path.join(STORAGE_DIR, 'peers.json');
const NODE_INFO_FILE = path.join(STORAGE_DIR, 'node-info.json');

// Get local IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return 'localhost';
}

const LOCAL_IP = getLocalIP();
const NODE_URL = `http://${LOCAL_IP}:${PORT}`;

// Network state
let connectedPeers = new Set();
let globalFileMetadata = new Map();
let localChunks = new Map();
let peerHealth = new Map();

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Configure multer for temporary file storage
const upload = multer({ 
    dest: 'temp/',
    limits: { fileSize: 500 * 1024 * 1024 }
});

// Persistent storage functions
async function ensureDirectories() {
    await fs.mkdir('temp', { recursive: true });
    await fs.mkdir('chunks', { recursive: true });
    await fs.mkdir(STORAGE_DIR, { recursive: true });
}

async function saveMetadata() {
    try {
        const metadataArray = Array.from(globalFileMetadata.entries());
        await fs.writeFile(METADATA_FILE, JSON.stringify(metadataArray, null, 2));
    } catch (error) {
        console.error('Failed to save metadata:', error);
    }
}

async function loadMetadata() {
    try {
        const data = await fs.readFile(METADATA_FILE, 'utf8');
        const metadataArray = JSON.parse(data);
        globalFileMetadata = new Map(metadataArray);
        console.log(`Loaded ${globalFileMetadata.size} file metadata entries`);
    } catch (error) {
        console.log('No previous metadata found, starting fresh');
        globalFileMetadata = new Map();
    }
}

async function savePeers() {
    try {
        const peersData = {
            connectedPeers: Array.from(connectedPeers),
            peerHealth: Array.from(peerHealth.entries())
        };
        await fs.writeFile(PEERS_FILE, JSON.stringify(peersData, null, 2));
    } catch (error) {
        console.error('Failed to save peers:', error);
    }
}

async function loadPeers() {
    try {
        const data = await fs.readFile(PEERS_FILE, 'utf8');
        const peersData = JSON.parse(data);
        connectedPeers = new Set(peersData.connectedPeers || []);
        peerHealth = new Map(peersData.peerHealth || []);
        console.log(`Loaded ${connectedPeers.size} peer connections`);
    } catch (error) {
        console.log('No previous peer data found, starting fresh');
        connectedPeers = new Set();
        peerHealth = new Map();
    }
}

async function saveNodeInfo() {
    try {
        const nodeInfo = {
            nodeName: NODE_NAME,
            nodeUrl: NODE_URL,
            lastStartup: new Date().toISOString()
        };
        await fs.writeFile(NODE_INFO_FILE, JSON.stringify(nodeInfo, null, 2));
    } catch (error) {
        console.error('Failed to save node info:', error);
    }
}

async function loadLocalChunks() {
    try {
        const chunkFiles = await fs.readdir('chunks');
        let loadedChunks = 0;
        
        for (const file of chunkFiles) {
            if (file.endsWith('.chunk')) {
                const chunkId = file.replace('.chunk', '');
                try {
                    const chunkPath = path.join('chunks', file);
                    const data = await fs.readFile(chunkPath, 'utf8');
                    
                    localChunks.set(chunkId, {
                        data,
                        storedAt: new Date().toISOString(),
                        loadedFromDisk: true
                    });
                    loadedChunks++;
                } catch (error) {
                    console.error(`Failed to load chunk ${chunkId}:`, error);
                }
            }
        }
        
        console.log(`Loaded ${loadedChunks} local chunks from disk`);
    } catch (error) {
        console.log('No previous chunks found or failed to load chunks');
    }
}

// Enhanced sync function to restore files
async function syncMetadataWithPeer(peerUrl) {
    try {
        const response = await axios.get(`${peerUrl}/metadata`);
        const peerMetadata = response.data.files;
        
        let restoredFiles = 0;
        peerMetadata.forEach(file => {
            if (!globalFileMetadata.has(file.id)) {
                globalFileMetadata.set(file.id, file);
                restoredFiles++;
            }
        });
        
        if (restoredFiles > 0) {
            await saveMetadata();
            console.log(`Restored ${restoredFiles} files from ${peerUrl}`);
        }
    } catch (error) {
        console.error(`Failed to sync metadata with ${peerUrl}:`, error.message);
    }
}

// Reconnect to previously connected peers
async function reconnectToPeers() {
    console.log('Attempting to reconnect to previous peers...');
    
    for (const peerUrl of connectedPeers) {
        try {
            const response = await axios.get(`${peerUrl}/health`, { timeout: 5000 });
            
            if (response.status === 200) {
                await axios.post(`${peerUrl}/peer-reconnected`, {
                    peerUrl: NODE_URL,
                    peerName: NODE_NAME
                });
                
                await syncMetadataWithPeer(peerUrl);
                
                peerHealth.set(peerUrl, {
                    ...peerHealth.get(peerUrl),
                    lastSeen: Date.now(),
                    active: true,
                    reconnected: true
                });
                
                console.log(`Reconnected to peer: ${peerUrl}`);
            }
        } catch (error) {
            console.log(`Failed to reconnect to peer ${peerUrl}: ${error.message}`);
            peerHealth.set(peerUrl, {
                ...peerHealth.get(peerUrl),
                active: false
            });
        }
    }
    
    await savePeers();
    await saveMetadata();
}

// Handle peer reconnection
app.post('/peer-reconnected', async (req, res) => {
    const { peerUrl, peerName } = req.body;
    
    if (peerUrl && peerUrl !== NODE_URL) {
        connectedPeers.add(peerUrl);
        peerHealth.set(peerUrl, { 
            lastSeen: Date.now(), 
            active: true, 
            name: peerName || 'Unknown',
            reconnected: true
        });
        
        console.log(`Peer reconnected: ${peerUrl} (${peerName})`);
        await savePeers();
    }
    
    res.json({ message: 'Reconnection acknowledged' });
});

// Peer discovery and connection
app.post('/connect-peer', async (req, res) => {
    const { peerUrl, peerName } = req.body;
    
    if (!peerUrl || peerUrl === NODE_URL) {
        return res.status(400).json({ error: 'Invalid peer URL' });
    }

    try {
        await axios.get(`${peerUrl}/health`);
        
        connectedPeers.add(peerUrl);
        peerHealth.set(peerUrl, { 
            lastSeen: Date.now(), 
            active: true, 
            name: peerName || 'Unknown'
        });

        try {
            await axios.post(`${peerUrl}/peer-connected`, {
                peerUrl: NODE_URL,
                peerName: NODE_NAME
            });
        } catch (error) {
            console.log('Failed to notify peer, but connection established');
        }

        await syncMetadataWithPeer(peerUrl);
        await savePeers();

        console.log(`Connected to peer: ${peerUrl} (${peerName})`);
        res.json({ message: 'Peer connected successfully' });

    } catch (error) {
        console.error(`Failed to connect to peer ${peerUrl}:`, error.message);
        res.status(500).json({ error: 'Failed to connect to peer' });
    }
});

// Handle incoming peer connections
app.post('/peer-connected', async (req, res) => {
    const { peerUrl, peerName } = req.body;
    
    if (peerUrl && peerUrl !== NODE_URL) {
        connectedPeers.add(peerUrl);
        peerHealth.set(peerUrl, { 
            lastSeen: Date.now(), 
            active: true, 
            name: peerName || 'Unknown'
        });
        
        await savePeers();
        console.log(`Peer connected: ${peerUrl} (${peerName})`);
    }
    
    res.json({ message: 'Connection acknowledged' });
});

// Remove peer endpoint
app.post('/remove-peer', async (req, res) => {
    const { peerUrl } = req.body;
    if (!peerUrl) {
        return res.status(400).json({ error: 'Peer URL required' });
    }

    if (!connectedPeers.has(peerUrl)) {
        return res.status(404).json({ error: 'Peer not found' });
    }

    try {
        try {
            await axios.post(`${peerUrl}/peer-disconnected`, {
                peerUrl: NODE_URL,
                peerName: NODE_NAME
            });
        } catch (error) {
            console.log('Failed to notify peer about disconnection');
        }

        connectedPeers.delete(peerUrl);
        peerHealth.delete(peerUrl);

        let removedFilesCount = 0;
        for (const [fileId, metadata] of globalFileMetadata.entries()) {
            if (metadata.uploadedFrom === peerUrl) {
                globalFileMetadata.delete(fileId);
                removedFilesCount++;
            }
        }

        await savePeers();
        await saveMetadata();

        console.log(`Removed peer: ${peerUrl}, hidden ${removedFilesCount} files`);
        res.json({ 
            message: `Peer removed successfully. Hidden ${removedFilesCount} files.`,
            removedFiles: removedFilesCount
        });

    } catch (error) {
        console.error('Error removing peer:', error);
        res.status(500).json({ error: 'Failed to remove peer' });
    }
});

// Handle peer disconnection notification
app.post('/peer-disconnected', async (req, res) => {
    const { peerUrl, peerName } = req.body;
    
    if (peerUrl && connectedPeers.has(peerUrl)) {
        connectedPeers.delete(peerUrl);
        peerHealth.delete(peerUrl);
        
        let removedFilesCount = 0;
        for (const [fileId, metadata] of globalFileMetadata.entries()) {
            if (metadata.uploadedFrom === peerUrl) {
                globalFileMetadata.delete(fileId);
                removedFilesCount++;
            }
        }
        
        await savePeers();
        await saveMetadata();
        
        console.log(`Peer disconnected: ${peerUrl} (${peerName}), hidden ${removedFilesCount} files`);
    }
    
    res.json({ message: 'Disconnection acknowledged' });
});

// Disconnect from all peers
app.post('/disconnect-all', async (req, res) => {
    try {
        let disconnectedCount = 0;
        let hiddenFiles = 0;
        
        for (const peerUrl of connectedPeers) {
            try {
                await axios.post(`${peerUrl}/peer-disconnected`, {
                    peerUrl: NODE_URL,
                    peerName: NODE_NAME
                });
            } catch (error) {
                console.log(`Failed to notify ${peerUrl} about disconnection`);
            }
            disconnectedCount++;
        }
        
        for (const [fileId, metadata] of globalFileMetadata.entries()) {
            if (metadata.uploadedFrom !== NODE_URL) {
                globalFileMetadata.delete(fileId);
                hiddenFiles++;
            }
        }
        
        connectedPeers.clear();
        peerHealth.clear();
        
        await savePeers();
        await saveMetadata();
        
        res.json({ 
            message: `Disconnected from ${disconnectedCount} peers, hidden ${hiddenFiles} files`,
            disconnectedPeers: disconnectedCount,
            hiddenFiles: hiddenFiles
        });
        
    } catch (error) {
        console.error('Error disconnecting from all peers:', error);
        res.status(500).json({ error: 'Failed to disconnect from all peers' });
    }
});

// Get metadata endpoint
app.get('/metadata', (req, res) => {
    const files = Array.from(globalFileMetadata.values());
    res.json({ files, nodeInfo: { name: NODE_NAME, url: NODE_URL } });
});

// Broadcast metadata to all peers
async function broadcastMetadata(fileMetadata) {
    const broadcastPromises = Array.from(connectedPeers).map(async (peerUrl) => {
        try {
            await axios.post(`${peerUrl}/receive-metadata`, {
                metadata: fileMetadata,
                sender: NODE_URL
            });
        } catch (error) {
            console.error(`Failed to broadcast to ${peerUrl}:`, error.message);
            peerHealth.set(peerUrl, { ...peerHealth.get(peerUrl), active: false });
        }
    });
    
    await Promise.allSettled(broadcastPromises);
}

// Receive metadata from peers
app.post('/receive-metadata', async (req, res) => {
    const { metadata, sender } = req.body;
    
    if (metadata && !globalFileMetadata.has(metadata.id)) {
        globalFileMetadata.set(metadata.id, metadata);
        await saveMetadata();
        console.log(`Received metadata for file: ${metadata.originalName} from ${sender}`);
    }
    
    res.json({ message: 'Metadata received' });
});

// File upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const activePeers = Array.from(connectedPeers).filter(peer => 
            peerHealth.get(peer)?.active !== false
        );

        const fileId = crypto.randomUUID();
        const filePath = req.file.path;
        const originalName = req.file.originalname;
        const fileSize = req.file.size;
        const mimeType = req.file.mimetype;
        
        const isVideo = mimeType.startsWith('video/');
        
        const fileBuffer = await fs.readFile(filePath);
        const totalNodes = activePeers.length + 1;
        const chunkSize = Math.ceil(fileSize / Math.min(totalNodes, 5));
        const chunks = [];
        
        for (let i = 0; i < fileBuffer.length; i += chunkSize) {
            chunks.push(fileBuffer.slice(i, i + chunkSize));
        }

        const allNodes = [NODE_URL, ...activePeers];
        const chunkMetadata = [];
        
        for (let i = 0; i < chunks.length; i++) {
            const nodeIndex = i % allNodes.length;
            const nodeUrl = allNodes[nodeIndex];
            const chunkId = crypto.randomUUID();
            
            try {
                if (nodeUrl === NODE_URL) {
                    localChunks.set(chunkId, {
                        fileId,
                        chunkIndex: i,
                        data: chunks[i].toString('base64'),
                        storedAt: new Date().toISOString()
                    });
                    
                    const chunkPath = path.join('chunks', `${chunkId}.chunk`);
                    await fs.writeFile(chunkPath, chunks[i].toString('base64'));
                } else {
                    await axios.post(`${nodeUrl}/store-chunk`, {
                        chunkId,
                        fileId,
                        chunkIndex: i,
                        data: chunks[i].toString('base64')
                    });
                }
                
                chunkMetadata.push({
                    chunkId,
                    chunkIndex: i,
                    nodeUrl,
                    nodeName: nodeUrl === NODE_URL ? NODE_NAME : (peerHealth.get(nodeUrl)?.name || 'Unknown'),
                    size: chunks[i].length
                });
            } catch (error) {
                console.error(`Failed to store chunk ${i} on node ${nodeUrl}:`, error.message);
                if (nodeUrl !== NODE_URL) {
                    peerHealth.set(nodeUrl, { ...peerHealth.get(nodeUrl), active: false });
                }
                return res.status(500).json({ error: 'Failed to distribute file chunks' });
            }
        }

        const fileMetadata = {
            id: fileId,
            originalName,
            size: fileSize,
            mimeType,
            isVideo,
            uploadTime: new Date().toISOString(),
            uploadedBy: NODE_NAME,
            uploadedFrom: NODE_URL,
            chunks: chunkMetadata,
            totalChunks: chunks.length
        };

        globalFileMetadata.set(fileId, fileMetadata);
        await saveMetadata();

        await broadcastMetadata(fileMetadata);

        await fs.unlink(filePath);

        res.json({
            message: 'File uploaded and distributed successfully',
            fileId,
            metadata: fileMetadata
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Store chunk endpoint
app.post('/store-chunk', async (req, res) => {
    try {
        const { chunkId, fileId, chunkIndex, data } = req.body;
        
        if (!chunkId || !fileId || chunkIndex === undefined || !data) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        localChunks.set(chunkId, {
            fileId,
            chunkIndex,
            data,
            storedAt: new Date().toISOString()
        });

        const chunkPath = path.join('chunks', `${chunkId}.chunk`);
        await fs.writeFile(chunkPath, data);

        console.log(`Stored chunk ${chunkId} for file ${fileId}`);
        res.json({ message: 'Chunk stored successfully' });

    } catch (error) {
        console.error('Store chunk error:', error);
        res.status(500).json({ error: 'Failed to store chunk' });
    }
});

// Get chunk endpoint
app.get('/get-chunk/:chunkId', async (req, res) => {
    try {
        const { chunkId } = req.params;
        
        let chunk = localChunks.get(chunkId);
        
        if (!chunk) {
            const chunkPath = path.join('chunks', `${chunkId}.chunk`);
            try {
                const data = await fs.readFile(chunkPath, 'utf8');
                chunk = { data };
            } catch (error) {
                return res.status(404).json({ error: 'Chunk not found' });
            }
        }

        res.json({ data: chunk.data });

    } catch (error) {
        console.error('Get chunk error:', error);
        res.status(500).json({ error: 'Failed to retrieve chunk' });
    }
});

// Helper functions for file data retrieval
async function getAllChunks(metadata) {
    const chunkPromises = metadata.chunks.map(async (chunkInfo) => {
        try {
            let response;
            if (chunkInfo.nodeUrl === NODE_URL) {
                const chunk = localChunks.get(chunkInfo.chunkId);
                if (chunk) {
                    response = { data: { data: chunk.data } };
                } else {
                    const chunkPath = path.join('chunks', `${chunkInfo.chunkId}.chunk`);
                    const data = await fs.readFile(chunkPath, 'utf8');
                    response = { data: { data } };
                }
            } else {
                response = await axios.get(`${chunkInfo.nodeUrl}/get-chunk/${chunkInfo.chunkId}`);
            }
            
            return {
                index: chunkInfo.chunkIndex,
                data: Buffer.from(response.data.data, 'base64')
            };
        } catch (error) {
            throw new Error(`Failed to retrieve chunk ${chunkInfo.chunkIndex} from ${chunkInfo.nodeUrl}`);
        }
    });

    const chunks = await Promise.all(chunkPromises);
    return chunks.sort((a, b) => a.index - b.index);
}

async function getFileDataRange(metadata, start, end) {
    const chunks = await getAllChunks(metadata);
    const completeBuffer = Buffer.concat(chunks.map(chunk => chunk.data));
    return completeBuffer.slice(start, end + 1);
}

async function getCompleteFileData(metadata) {
    const chunks = await getAllChunks(metadata);
    return Buffer.concat(chunks.map(chunk => chunk.data));
}

// Video streaming endpoint
app.get('/stream/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const metadata = globalFileMetadata.get(fileId);
        
        if (!metadata) {
            return res.status(404).json({ error: 'File not found' });
        }

        if (!metadata.isVideo) {
            return res.status(400).json({ error: 'File is not a video' });
        }

        const range = req.headers.range;
        const fileSize = metadata.size;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            const fileData = await getFileDataRange(metadata, start, end);

            const headers = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': metadata.mimeType,
            };

            res.writeHead(206, headers);
            res.end(fileData);
        } else {
            const fileData = await getCompleteFileData(metadata);
            
            const headers = {
                'Content-Length': fileSize,
                'Content-Type': metadata.mimeType,
            };

            res.writeHead(200, headers);
            res.end(fileData);
        }

    } catch (error) {
        console.error('Stream error:', error);
        res.status(500).json({ error: 'Streaming failed' });
    }
});

// Get all files
app.get('/files', (req, res) => {
    const files = Array.from(globalFileMetadata.values());
    res.json({ files });
});

// Download file
app.get('/download/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const metadata = globalFileMetadata.get(fileId);
        
        if (!metadata) {
            return res.status(404).json({ error: 'File not found' });
        }

        const chunks = await getAllChunks(metadata);
        const fileBuffer = Buffer.concat(chunks.map(chunk => chunk.data));

        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName}"`);
        res.setHeader('Content-Type', metadata.mimeType);
        res.send(fileBuffer);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Download failed' });
    }
});

// Get peer status with file counts
app.get('/peer-status', (req, res) => {
    const peerStatus = Array.from(connectedPeers).map(peerUrl => {
        const filesFromPeer = Array.from(globalFileMetadata.values())
            .filter(file => file.uploadedFrom === peerUrl).length;
        
        return {
            url: peerUrl,
            name: peerHealth.get(peerUrl)?.name || 'Unknown',
            active: peerHealth.get(peerUrl)?.active !== false,
            lastSeen: peerHealth.get(peerUrl)?.lastSeen,
            filesCount: filesFromPeer
        };
    });
    
    const localFiles = Array.from(globalFileMetadata.values())
        .filter(file => file.uploadedFrom === NODE_URL).length;
    
    res.json({ 
        peers: peerStatus,
        thisNode: { 
            name: NODE_NAME, 
            url: NODE_URL,
            filesCount: localFiles
        },
        totalFiles: globalFileMetadata.size
    });
});

// Get connected peers
app.get('/peers', (req, res) => {
    const peers = Array.from(connectedPeers).map(peerUrl => ({
        url: peerUrl,
        name: peerHealth.get(peerUrl)?.name || 'Unknown',
        active: peerHealth.get(peerUrl)?.active !== false,
        lastSeen: peerHealth.get(peerUrl)?.lastSeen,
        reconnected: peerHealth.get(peerUrl)?.reconnected || false
    }));
    
    res.json({ 
        peers,
        thisNode: { name: NODE_NAME, url: NODE_URL }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        nodeName: NODE_NAME,
        nodeUrl: NODE_URL,
        connectedPeers: connectedPeers.size,
        localChunks: localChunks.size,
        globalFiles: globalFileMetadata.size
    });
});

// Periodic health check with peers and save state
setInterval(async () => {
    for (const peerUrl of connectedPeers) {
        try {
            await axios.get(`${peerUrl}/health`, { timeout: 5000 });
            peerHealth.set(peerUrl, { 
                ...peerHealth.get(peerUrl), 
                lastSeen: Date.now(), 
                active: true 
            });
        } catch (error) {
            console.error(`Health check failed for ${peerUrl}`);
            peerHealth.set(peerUrl, { 
                ...peerHealth.get(peerUrl), 
                active: false 
            });
        }
    }
    
    await savePeers();
    await saveMetadata();
}, 30000);

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    await savePeers();
    await saveMetadata();
    await saveNodeInfo();
    console.log('State saved. Goodbye!');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...');
    await savePeers();
    await saveMetadata();
    await saveNodeInfo();
    console.log('State saved. Goodbye!');
    process.exit(0);
});

// Initialize and start the server
async function initialize() {
    try {
        await ensureDirectories();
        await loadMetadata();
        await loadPeers();
        await loadLocalChunks();
        await saveNodeInfo();
        
        app.listen(PORT, '0.0.0.0', async () => {
            console.log(`P2P Node "${NODE_NAME}" running on http://${LOCAL_IP}:${PORT}`);
            console.log(`Node URL: ${NODE_URL}`);
            console.log(`Loaded ${globalFileMetadata.size} files and ${connectedPeers.size} peer connections from previous session`);
            
            if (connectedPeers.size > 0) {
                setTimeout(() => reconnectToPeers(), 2000);
            }
        });
    } catch (error) {
        console.error('Failed to initialize:', error);
        process.exit(1);
    }
}

initialize();

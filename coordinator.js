// coordinator.js
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for metadata and node tracking
let fileMetadata = {};
let storageNodes = new Set();
let nodeHealth = {};

app.use(express.json());
app.use(express.static('public'));

// Configure multer for temporary file storage
const upload = multer({ 
    dest: 'temp/',
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Storage node registration
app.post('/register-node', (req, res) => {
    const { nodeUrl } = req.body;
    if (!nodeUrl) {
        return res.status(400).json({ error: 'Node URL required' });
    }
    
    storageNodes.add(nodeUrl);
    nodeHealth[nodeUrl] = { lastSeen: Date.now(), active: true };
    console.log(`Storage node registered: ${nodeUrl}`);
    res.json({ message: 'Node registered successfully' });
});

// Get available storage nodes
app.get('/nodes', (req, res) => {
    const activeNodes = Array.from(storageNodes).filter(node => 
        nodeHealth[node] && nodeHealth[node].active
    );
    res.json({ nodes: activeNodes });
});

// File upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const activeNodes = Array.from(storageNodes).filter(node => 
            nodeHealth[node] && nodeHealth[node].active
        );

        if (activeNodes.length === 0) {
            return res.status(503).json({ error: 'No storage nodes available' });
        }

        const fileId = crypto.randomUUID();
        const filePath = req.file.path;
        const originalName = req.file.originalname;
        const fileSize = req.file.size;
        
        // Read the file and split into chunks
        const fileBuffer = await fs.readFile(filePath);
        const chunkSize = Math.ceil(fileSize / Math.min(activeNodes.length, 3)); // Max 3 chunks
        const chunks = [];
        
        for (let i = 0; i < fileBuffer.length; i += chunkSize) {
            chunks.push(fileBuffer.slice(i, i + chunkSize));
        }

        // Distribute chunks across nodes
        const chunkMetadata = [];
        for (let i = 0; i < chunks.length; i++) {
            const nodeIndex = i % activeNodes.length;
            const nodeUrl = activeNodes[nodeIndex];
            const chunkId = crypto.randomUUID();
            
            try {
                // Send chunk to storage node
                await axios.post(`${nodeUrl}/store-chunk`, {
                    chunkId,
                    fileId,
                    chunkIndex: i,
                    data: chunks[i].toString('base64')
                });
                
                chunkMetadata.push({
                    chunkId,
                    chunkIndex: i,
                    nodeUrl,
                    size: chunks[i].length
                });
            } catch (error) {
                console.error(`Failed to store chunk ${i} on node ${nodeUrl}:`, error.message);
                // Mark node as inactive
                nodeHealth[nodeUrl].active = false;
                return res.status(500).json({ error: 'Failed to distribute file chunks' });
            }
        }

        // Store file metadata
        fileMetadata[fileId] = {
            id: fileId,
            originalName,
            size: fileSize,
            uploadTime: new Date().toISOString(),
            chunks: chunkMetadata,
            totalChunks: chunks.length
        };

        // Clean up temporary file
        await fs.unlink(filePath);

        res.json({
            message: 'File uploaded and distributed successfully',
            fileId,
            metadata: fileMetadata[fileId]
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Get file metadata
app.get('/files', (req, res) => {
    res.json({ files: Object.values(fileMetadata) });
});

// Download file (reassemble chunks)
app.get('/download/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const metadata = fileMetadata[fileId];
        
        if (!metadata) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Retrieve all chunks
        const chunkPromises = metadata.chunks.map(async (chunkInfo) => {
            try {
                const response = await axios.get(
                    `${chunkInfo.nodeUrl}/get-chunk/${chunkInfo.chunkId}`
                );
                return {
                    index: chunkInfo.chunkIndex,
                    data: Buffer.from(response.data.data, 'base64')
                };
            } catch (error) {
                throw new Error(`Failed to retrieve chunk ${chunkInfo.chunkIndex}`);
            }
        });

        const chunks = await Promise.all(chunkPromises);
        
        // Sort chunks by index and concatenate
        chunks.sort((a, b) => a.index - b.index);
        const fileBuffer = Buffer.concat(chunks.map(chunk => chunk.data));

        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(fileBuffer);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Download failed' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        nodes: Object.keys(nodeHealth).length,
        files: Object.keys(fileMetadata).length
    });
});

app.listen(PORT, () => {
    console.log(`Coordinator server running on http://localhost:${PORT}`);
});

// Update the listen call
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Coordinator server running on http://${config.COORDINATOR_IP}:${PORT}`);
    console.log(`Share this URL with other computers: http://${config.COORDINATOR_IP}:${PORT}`);
});
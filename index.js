const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

// Folder icon for display
const FOLDER_ICON = '📁';

// Emoji thresholds
const PRINT_RED_SIZE = 100; // Threshold for red indicator (GB)
const PRINT_YELLOW_SIZE = 10; // Threshold for yellow indicator (GB)
const PRINT_GREEN_SIZE = 5; // Threshold for green indicator (GB)

// Command-line argument for shared drive ID
const SHARED_DRIVE_ID = process.argv[2];
if (!SHARED_DRIVE_ID) {
  console.error(
    'Error: Please provide a shared drive ID as a command-line argument.'
  );
  process.exit(1);
}

const SHARED_DRIVE_NAME = process.argv[3] || `Shared Drive_${SHARED_DRIVE_ID}`; // Optional name for shared drive

// Google Drive API scopes for read-only access
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Paths for credentials and token
const CREDENTIALS_PATH = './credentials_web.json';
const TOKEN_PATH = 'token.json';

// Output file for logging
const outputFile = path.join(__dirname, `${SHARED_DRIVE_NAME}_Contents.txt`);
const outputStream = fs.createWriteStream(outputFile, { flags: 'w' });

// Custom logging function to handle multiple arguments
function logOutput(...messages) {
  const message = messages.join(' ');
  console.log(message); // Log to terminal
  outputStream.write(message + '\n'); // Write to file
}

// Load OAuth client credentials and start authorization
fs.readFile(CREDENTIALS_PATH, (err, content) => {
  if (err) return logOutput('Error loading client secret file:', err);
  authorize(JSON.parse(content), listFolders);
});

// Create an OAuth2 client with the given credentials
function authorize(credentials, callback) {
  const { client_secret, client_id, redirect_uris } = credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if a token is already stored
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) {
      // No token found, get a new one
      return getNewToken(oAuth2Client, callback);
    }

    // Set the existing token and add a listener for token refreshes
    oAuth2Client.setCredentials(JSON.parse(token));

    // Save refreshed tokens automatically
    oAuth2Client.on('tokens', (newTokens) => {
      if (newTokens.refresh_token) {
        oAuth2Client.setCredentials(newTokens);
        saveToken(newTokens);
      }
    });

    callback(oAuth2Client); // Pass the authenticated client
  });
}

// Save token to file
function saveToken(token) {
  fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
    if (err) return logOutput('Error saving token:', err);
    logOutput('Token stored to', TOKEN_PATH);
  });
}

// Get and store new token, using localhost redirect
function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  // Explicitly log the URL to ensure it shows up in the output
  logOutput('Authorize this app by visiting this URL:', authUrl);

  // Create a local server to listen for the authorization code
  const server = http
    .createServer((req, res) => {
      if (req.url.startsWith('/?code=')) {
        const query = url.parse(req.url, true).query;
        const code = query.code;

        // Exchange authorization code for tokens
        oAuth2Client.getToken(code, (err, token) => {
          if (err) return logOutput('Error retrieving access token', err);
          oAuth2Client.setCredentials(token);
          saveToken(token); // Save token after obtaining it
          callback(oAuth2Client);

          // Close the server and return a success message
          res.end('Authorization successful! You can close this window.');
          server.close();
        });
      }
    })
    .listen(3000, () => {
      logOutput('Waiting for authorization code on http://localhost:3000');
    });
}

// Recursive function to list only folders and their sizes in a shared drive with a tree structure
async function listFolders(auth, folderId = null, prefix = '') {
  const drive = google.drive({ version: 'v3', auth });
  const query = `'${
    folderId || SHARED_DRIVE_ID
  }' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'drive',
    driveId: SHARED_DRIVE_ID,
  });

  let folders = res.data.files;

  // Sort folders alphabetically by name in ascending order
  folders = folders.sort((a, b) => a.name.localeCompare(b.name));

  // Check if the current folder has subfolders
  if (folders.length === 0) return;

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const isLastFolder = i === folders.length - 1;

    // Determine prefix and branch symbols
    const branch = isLastFolder ? '└── ' : '├── ';
    const newPrefix = prefix + (isLastFolder ? '    ' : '│   ');

    // Calculate folder size, file count, and get emoji indicator based on size
    const { size, fileCount } = await calculateFolderSizeAndCount(
      drive,
      folder.id
    );
    const { formattedSize, emoji } = formatSizeWithEmoji(size);

    logOutput(
      `${prefix}${branch}${FOLDER_ICON} ${folder.name} (Size: ${formattedSize}, Files: ${fileCount}) ${emoji}`
    );

    // Recursive call for subfolders with updated prefix
    await listFolders(auth, folder.id, newPrefix);
  }
}

// Function to format folder size and return appropriate emoji
function formatSizeWithEmoji(sizeInBytes) {
  const sizeInMB = sizeInBytes / (1024 * 1024);
  let emoji = '';

  if (sizeInMB > 1024) {
    const sizeInGB = (sizeInMB / 1024).toFixed(2);
    emoji =
      sizeInGB > PRINT_RED_SIZE
        ? '🔴'
        : sizeInGB > PRINT_YELLOW_SIZE
        ? '🟡'
        : sizeInGB > PRINT_GREEN_SIZE
        ? '🟢'
        : '';
    return { formattedSize: `${sizeInGB} GB`, emoji };
  } else {
    return { formattedSize: `${sizeInMB.toFixed(2)} MB`, emoji };
  }
}

// Function to calculate folder size and count the number of files
async function calculateFolderSizeAndCount(drive, folderId) {
  let pageToken = null;
  let totalSize = 0;
  let fileCount = 0;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(size)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      driveId: SHARED_DRIVE_ID,
      corpora: 'drive',
      pageToken: pageToken,
    });

    const files = res.data.files;
    files.forEach((file) => {
      if (file.size) totalSize += parseInt(file.size, 10);
      fileCount++; // Count each file
    });

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return { size: totalSize, fileCount };
}

// Start listing folders from the root of the shared drive
logOutput(`Contents of Shared Drive (ID: ${SHARED_DRIVE_ID}):`);

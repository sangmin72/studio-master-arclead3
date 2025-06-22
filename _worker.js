export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    // Handle CORS preflight requests
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Serve HTML files
      if (path === '/' || path === '/admin-artists.html') {
        return await serveHTML(env);
      }

      // API Routes
      if (path.startsWith('/api/artists')) {
        return await handleArtistsAPI(request, env, corsHeaders);
      }

      // File management routes
      if (path.startsWith('/admin/files/artists')) {
        return await handleFileManagement(request, env, corsHeaders);
      }

      // Asset serving (images from R2)
      if (path.startsWith('/assets/artists/')) {
        return await serveAsset(request, env, corsHeaders);
      }

      // 404 for other routes
      return new Response('Not Found', { status: 404 });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error: ' + error.message, { 
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

// Serve HTML file
async function serveHTML(env) {
  // You'll need to store your HTML content in KV or hardcode it here
  // For now, returning a simple response that tells user to upload HTML
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Admin Artists</title>
    </head>
    <body>
      <h1>Admin Artists Setup</h1>
      <p>Please upload your admin-artists.html content to KV storage with key 'admin-artists-html'</p>
      <p>Or modify this worker to include the HTML content directly.</p>
    </body>
    </html>
  `;
  
  // Try to get HTML from KV first
  try {
    const storedHTML = await env.ARTISTS_KV.get('admin-artists-html');
    if (storedHTML) {
      return new Response(storedHTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
  } catch (error) {
    console.log('Could not load HTML from KV:', error);
  }
  
  return new Response(htmlContent, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// Handle Artists API
async function handleArtistsAPI(request, env, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // GET /api/artists - Get all artists
  if (method === 'GET' && path === '/api/artists') {
    try {
      const artistsData = await env.ARTISTS_KV.get('artists', 'json');
      const artists = artistsData || [];
      
      return new Response(JSON.stringify(artists), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to fetch artists' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // POST /api/artists - Create new artist
  if (method === 'POST' && path === '/api/artists') {
    try {
      const formData = await request.formData();
      const artistDataStr = formData.get('artistData');
      const artistData = JSON.parse(artistDataStr);
      
      // Validate required fields
      if (!artistData.id || !artistData.name) {
        return new Response(JSON.stringify({ error: 'ID and name are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Get existing artists
      const existingArtists = await env.ARTISTS_KV.get('artists', 'json') || [];
      
      // Check for duplicate ID
      if (existingArtists.some(artist => artist.id === artistData.id)) {
        return new Response(JSON.stringify({ error: 'Artist ID already exists' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Handle image uploads
      const images = formData.getAll('images');
      const uploadedImages = [];
      
      for (const image of images) {
        if (image && image.size > 0) {
          const imageKey = `artists/${artistData.id}/${image.name}`;
          await env.ARTISTS_BUCKET.put(imageKey, image);
          uploadedImages.push(image.name);
        }
      }

      // Create artist object
      const newArtist = {
        ...artistData,
        images: uploadedImages,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Add to artists list
      existingArtists.push(newArtist);
      await env.ARTISTS_KV.put('artists', JSON.stringify(existingArtists));

      return new Response(JSON.stringify({ 
        success: true, 
        artist: newArtist 
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });

    } catch (error) {
      console.error('Error creating artist:', error);
      return new Response(JSON.stringify({ error: 'Failed to create artist: ' + error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // PUT /api/artists/:id - Update artist
  if (method === 'PUT' && path.startsWith('/api/artists/')) {
    try {
      const artistId = decodeURIComponent(path.split('/').pop());
      const formData = await request.formData();
      const artistDataStr = formData.get('artistData');
      const artistData = JSON.parse(artistDataStr);
      
      // Get existing artists
      const existingArtists = await env.ARTISTS_KV.get('artists', 'json') || [];
      const artistIndex = existingArtists.findIndex(artist => artist.id === artistId);
      
      if (artistIndex === -1) {
        return new Response(JSON.stringify({ error: 'Artist not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Handle new image uploads
      const images = formData.getAll('images');
      const newImages = [];
      
      for (const image of images) {
        if (image && image.size > 0) {
          const imageKey = `artists/${artistData.id}/${image.name}`;
          await env.ARTISTS_BUCKET.put(imageKey, image);
          newImages.push(image.name);
        }
      }

      // Update artist object
      const currentArtist = existingArtists[artistIndex];
      const updatedArtist = {
        ...currentArtist,
        ...artistData,
        images: [...(currentArtist.images || []), ...newImages],
        updatedAt: new Date().toISOString()
      };

      // If ID changed, need to move images
      if (artistId !== artistData.id) {
        // Move images to new location
        const existingImages = currentArtist.images || [];
        for (const imageName of existingImages) {
          try {
            const oldKey = `artists/${artistId}/${imageName}`;
            const newKey = `artists/${artistData.id}/${imageName}`;
            
            const imageObject = await env.ARTISTS_BUCKET.get(oldKey);
            if (imageObject) {
              await env.ARTISTS_BUCKET.put(newKey, imageObject.body);
              await env.ARTISTS_BUCKET.delete(oldKey);
            }
          } catch (error) {
            console.error(`Error moving image ${imageName}:`, error);
          }
        }
      }

      existingArtists[artistIndex] = updatedArtist;
      await env.ARTISTS_KV.put('artists', JSON.stringify(existingArtists));

      return new Response(JSON.stringify({ 
        success: true, 
        artist: updatedArtist 
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });

    } catch (error) {
      console.error('Error updating artist:', error);
      return new Response(JSON.stringify({ error: 'Failed to update artist: ' + error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // DELETE /api/artists/:id - Delete artist
  if (method === 'DELETE' && path.startsWith('/api/artists/')) {
    try {
      const artistId = decodeURIComponent(path.split('/').pop());
      
      // Get existing artists
      const existingArtists = await env.ARTISTS_KV.get('artists', 'json') || [];
      const artistIndex = existingArtists.findIndex(artist => artist.id === artistId);
      
      if (artistIndex === -1) {
        return new Response(JSON.stringify({ error: 'Artist not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const artist = existingArtists[artistIndex];
      
      // Delete all images from R2
      if (artist.images && artist.images.length > 0) {
        for (const imageName of artist.images) {
          try {
            const imageKey = `artists/${artistId}/${imageName}`;
            await env.ARTISTS_BUCKET.delete(imageKey);
          } catch (error) {
            console.error(`Error deleting image ${imageName}:`, error);
          }
        }
      }

      // Remove artist from list
      existingArtists.splice(artistIndex, 1);
      await env.ARTISTS_KV.put('artists', JSON.stringify(existingArtists));

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });

    } catch (error) {
      console.error('Error deleting artist:', error);
      return new Response(JSON.stringify({ error: 'Failed to delete artist: ' + error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
}

// Handle file management
async function handleFileManagement(request, env, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // DELETE /admin/files/artists/:artistId/:imageName
  if (method === 'DELETE' && path.startsWith('/admin/files/artists/')) {
    try {
      const pathParts = path.split('/');
      const artistId = decodeURIComponent(pathParts[4]);
      const imageName = decodeURIComponent(pathParts[5]);
      
      // Delete from R2
      const imageKey = `artists/${artistId}/${imageName}`;
      await env.ARTISTS_BUCKET.delete(imageKey);
      
      // Update artist data
      const existingArtists = await env.ARTISTS_KV.get('artists', 'json') || [];
      const artistIndex = existingArtists.findIndex(artist => artist.id === artistId);
      
      if (artistIndex !== -1) {
        const artist = existingArtists[artistIndex];
        if (artist.images) {
          artist.images = artist.images.filter(img => img !== imageName);
          
          // Clear representative images if they were using this image
          if (artist.representativeImages) {
            if (artist.representativeImages.home === imageName) {
              artist.representativeImages.home = null;
            }
            if (artist.representativeImages.artists === imageName) {
              artist.representativeImages.artists = null;
            }
          }
          
          artist.updatedAt = new Date().toISOString();
          existingArtists[artistIndex] = artist;
          await env.ARTISTS_KV.put('artists', JSON.stringify(existingArtists));
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });

    } catch (error) {
      console.error('Error deleting file:', error);
      return new Response(JSON.stringify({ error: 'Failed to delete file: ' + error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
}

// Serve assets from R2
async function serveAsset(request, env, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // Extract key from path: /assets/artists/artistId/imageName
  const key = path.replace('/assets/', '');
  
  try {
    const object = await env.ARTISTS_BUCKET.get(key);
    
    if (!object) {
      return new Response('Image not found', { status: 404, headers: corsHeaders });
    }

    const headers = {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000', // 1 year cache
      'ETag': object.httpEtag,
      ...corsHeaders
    };

    // Handle conditional requests
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(object.body, { headers });

  } catch (error) {
    console.error('Error serving asset:', error);
    return new Response('Error serving asset', { status: 500, headers: corsHeaders });
  }
} 
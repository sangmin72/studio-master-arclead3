export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // API routes
        if (url.pathname.startsWith('/api/')) {
            return handleApiRequest(request, env);
        }

        // For other requests, serve static assets from Pages.
        // This is the default behavior for Cloudflare Pages Functions.
        return env.ASSETS.fetch(request);
    },
};

const ACTORS_JSON_KEY = 'actors.json';

async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const pathParts = url.pathname.replace('/api/', '').split('/');
    const method = request.method;

    // Route for serving photos from R2
    // GET /api/photos/:key
    if (pathParts[0] === 'photos' && pathParts[1]) {
        const photoKey = `photos/${pathParts[1]}`;
        const object = await env.R2_BUCKET.get(photoKey);

        if (object === null) {
            return new Response('Object Not Found', { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);

        return new Response(object.body, {
            headers,
        });
    }

    // GET /api/actors - get all actors for the main page
    if (method === 'GET' && pathParts[0] === 'actors' && !pathParts[1]) {
        const actors = await getActorsList(env);
        const mainPageActors = actors.map(actor => ({
            id: actor.id,
            name: actor.name,
            large_text: actor.large_text,
            small_text: actor.small_text,
            main_photo: actor.main_photo // This should now be a URL like /api/photos/some-key.jpg
        }));
        return new Response(JSON.stringify(mainPageActors), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // GET /api/all-photos - get all photos from all actors for portfolio
    if (method === 'GET' && pathParts[0] === 'all-photos' && !pathParts[1]) {
        const actors = await getActorsList(env);
        const allPhotos = actors.flatMap(actor =>
            actor.photos.map(photoUrl => ({
                actorId: actor.id,
                actorName: actor.name,
                photoUrl: photoUrl
            }))
        );
        return new Response(JSON.stringify(allPhotos), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
    
    // POST /api/admin/actors - Add a new actor
    if (method === 'POST' && pathParts[0] === 'admin' && pathParts[1] === 'actors') {
        try {
            const formData = await request.formData();
            
            // Get existing actors list or create a new one
            const actors = await getActorsList(env);

            // Upload photos to R2 and get their keys
            const mainPhotoFile = formData.get('main_photo');
            const portfolioPhotoFiles = formData.getAll('portfolio_photos');
            
            const mainPhotoKey = `photos/${crypto.randomUUID()}-${mainPhotoFile.name}`;
            await env.R2_BUCKET.put(mainPhotoKey, mainPhotoFile.stream(), {
                 httpMetadata: { contentType: mainPhotoFile.type },
            });

            const portfolioPhotoKeys = await Promise.all(
                portfolioPhotoFiles.map(async (file) => {
                    if(file.size === 0) return null;
                    const key = `photos/${crypto.randomUUID()}-${file.name}`;
                    await env.R2_BUCKET.put(key, file.stream(), {
                        httpMetadata: { contentType: file.type },
                    });
                    return key;
                })
            );

            // Create new actor object
            const newActor = {
                id: crypto.randomUUID(),
                name: formData.get('name'),
                large_text: formData.get('large_text'),
                small_text: formData.get('small_text'),
                main_photo: `/api/${mainPhotoKey}`,
                photos: portfolioPhotoKeys.filter(k => k !== null).map(k => `/api/${k}`)
            };
            
            // Add to list and save back to R2
            actors.push(newActor);
            await env.R2_BUCKET.put(ACTORS_JSON_KEY, JSON.stringify(actors));

            return new Response(JSON.stringify(newActor), { status: 201 });

        } catch (error) {
            return new Response(`Error processing request: ${error.message}`, { status: 500 });
        }
    }

    return new Response('Not Found', { status: 404 });
}

// Helper function to get the list of actors from R2
async function getActorsList(env) {
    const actorsObject = await env.R2_BUCKET.get(ACTORS_JSON_KEY);
    if (actorsObject === null) {
        return [];
    }
    return actorsObject.json();
} 
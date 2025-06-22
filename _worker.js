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
        // Transform data for public consumption
        const publicActors = actors.map(actor => ({
            id: actor.id,
            name: actor.name,
            large_text: actor.large_text,
            small_text: actor.small_text || `${actors.indexOf(actor) + 1}.`, // Keep for backward compatibility or use index
            main_photo: actor.main_photo
        }));
        return new Response(JSON.stringify(publicActors), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // GET /api/admin/actors - get full actor details for admin page
    if (method === 'GET' && pathParts[0] === 'admin' && pathParts[1] === 'actors') {
        const actors = await getActorsList(env);
        return new Response(JSON.stringify(actors), {
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
            const actors = await getActorsList(env);

            const mainPhotoFile = formData.get('main_photo');
            const portfolioPhotoFiles = formData.getAll('portfolio_photos');
            
            let mainPhotoKey = null;
            if (mainPhotoFile && mainPhotoFile.size > 0) {
                mainPhotoKey = `photos/${crypto.randomUUID()}-${mainPhotoFile.name}`;
                await env.R2_BUCKET.put(mainPhotoKey, mainPhotoFile.stream(), {
                     httpMetadata: { contentType: mainPhotoFile.type },
                });
            }

            const portfolioPhotoKeys = await Promise.all(
                portfolioPhotoFiles.map(async (file) => {
                    if(!file || file.size === 0) return null;
                    const key = `photos/${crypto.randomUUID()}-${file.name}`;
                    await env.R2_BUCKET.put(key, file.stream(), {
                        httpMetadata: { contentType: file.type },
                    });
                    return `/api/${key}`;
                })
            );

            const newActor = {
                id: crypto.randomUUID(),
                name: formData.get('name'),
                english_name: formData.get('english_name'),
                large_text: formData.get('large_text'),
                small_text: formData.get('small_text'),
                main_photo: mainPhotoKey ? `/api/${mainPhotoKey}` : null,
                photos: portfolioPhotoKeys.filter(k => k !== null),
                works: JSON.parse(formData.get('works') || '[]')
            };
            
            actors.push(newActor);
            await env.R2_BUCKET.put(ACTORS_JSON_KEY, JSON.stringify(actors));

            return new Response(JSON.stringify(newActor), { status: 201 });

        } catch (error) {
            return new Response(`Error processing request: ${error.message}`, { status: 500 });
        }
    }

    // PUT /api/admin/actors/:id - Update an existing actor
    if (method === 'PUT' && pathParts[0] === 'admin' && pathParts[1] === 'actors' && pathParts[2]) {
        try {
            const actorId = pathParts[2];
            const formData = await request.formData();
            const actors = await getActorsList(env);
            const actorIndex = actors.findIndex(a => a.id === actorId);

            if (actorIndex === -1) {
                return new Response('Actor not found', { status: 404 });
            }

            const existingActor = actors[actorIndex];

            // Update text fields
            existingActor.name = formData.get('name') || existingActor.name;
            existingActor.english_name = formData.get('english_name') || existingActor.english_name;
            existingActor.large_text = formData.get('large_text') || existingActor.large_text;
            existingActor.small_text = formData.get('small_text') || existingActor.small_text;
            existingActor.works = JSON.parse(formData.get('works') || JSON.stringify(existingActor.works));

            // Update main photo if a new one is uploaded
            const mainPhotoFile = formData.get('main_photo');
            if (mainPhotoFile && mainPhotoFile.size > 0) {
                const mainPhotoKey = `photos/${crypto.randomUUID()}-${mainPhotoFile.name}`;
                await env.R2_BUCKET.put(mainPhotoKey, mainPhotoFile.stream(), {
                     httpMetadata: { contentType: mainPhotoFile.type },
                });
                existingActor.main_photo = `/api/${mainPhotoKey}`;
            }

            // Add new portfolio photos
            const newPortfolioFiles = formData.getAll('portfolio_photos');
            const newPhotoKeys = await Promise.all(
                newPortfolioFiles.map(async (file) => {
                    if (!file || file.size === 0) return null;
                    const key = `photos/${crypto.randomUUID()}-${file.name}`;
                    await env.R2_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
                    return `/api/${key}`;
                })
            );
            
            // Handle photo deletions
            const photosToDelete = JSON.parse(formData.get('photos_to_delete') || '[]');
            if (photosToDelete.length > 0) {
                 // R2 bulk delete is preferred in production
                for (const photoUrl of photosToDelete) {
                    const key = photoUrl.replace('/api/', '');
                    await env.R2_BUCKET.delete(key);
                }
            }

            // Combine old photos (minus deleted ones) with new ones
            const existingPhotos = existingActor.photos.filter(p => !photosToDelete.includes(p));
            existingActor.photos = [...existingPhotos, ...newPhotoKeys.filter(k => k)];
            
            actors[actorIndex] = existingActor;
            await env.R2_BUCKET.put(ACTORS_JSON_KEY, JSON.stringify(actors));

            return new Response(JSON.stringify(existingActor), { status: 200 });
        } catch (error) {
            return new Response(`Error processing request: ${error.message}`, { status: 500 });
        }
    }

    // DELETE /api/admin/actors/:id - Delete an actor
    if (method === 'DELETE' && pathParts[0] === 'admin' && pathParts[1] === 'actors' && pathParts[2]) {
        try {
            const actorId = pathParts[2];
            const actors = await getActorsList(env);
            const actorToDelete = actors.find(a => a.id === actorId);

            if (!actorToDelete) {
                return new Response('Actor not found', { status: 404 });
            }

            // Delete photos from R2
            const photosToDelete = [actorToDelete.main_photo, ...actorToDelete.photos].filter(p => p);
            const keysToDelete = photosToDelete.map(url => url.replace('/api/', ''));
            // R2 bulk delete is preferred in production, but iterating is fine for this scale
            for (const key of keysToDelete) {
                await env.R2_BUCKET.delete(key);
            }

            // Remove actor from list and update
            const updatedActors = actors.filter(a => a.id !== actorId);
            await env.R2_BUCKET.put(ACTORS_JSON_KEY, JSON.stringify(updatedActors));

            return new Response(JSON.stringify({ message: 'Actor deleted successfully' }), { status: 200 });

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
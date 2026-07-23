/* Registry of the two Taxio Supabase projects this agent can connect to. Values copied
   verbatim from each app's own config.js - the anon key is already public/committed in each
   app's own client bundle (RLS + the signed-in user's own JWT are what actually gate access,
   not this key), so embedding it here is no different from embedding it there. */
module.exports = {
    taxio_hub: {
        id: 'taxio_hub',
        label: 'Taxio Hub',
        url: 'https://prrazpbbmgzczjwgwatm.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBycmF6cGJibWd6Y3pqd2d3YXRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2OTAyMTgsImV4cCI6MjEwMDI2NjIxOH0.FqMm-ZfSMY3iYbpSjZLBxlQaKC8wmo0sNVJDjNdYneU'
    }
};

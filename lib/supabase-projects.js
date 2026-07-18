/* Registry of the two Taxio Supabase projects this agent can connect to. Values copied
   verbatim from each app's own config.js - the anon key is already public/committed in each
   app's own client bundle (RLS + the signed-in user's own JWT are what actually gate access,
   not this key), so embedding it here is no different from embedding it there. */
module.exports = {
    grup: {
        id: 'grup',
        label: 'Taxio (Grup)',
        url: 'https://tuwteuegfunszccmvncl.supabase.co',
        anonKey: 'sb_publishable_f0wro8WvMEyla1cvsSUNMA_qgxGS3mW'
    },
    personal: {
        id: 'personal',
        label: 'Taxio.me',
        url: 'https://ilvnpsgljjxmgxeetblr.supabase.co',
        anonKey: 'sb_publishable_PcYL4OVkhygcJvX6zYpmbQ_i_JL_RZn'
    }
};





export function getSearchTokens(search:string){
    let parts = search.split("||");
    let tokens:string[][] = [];
    parts.forEach((p)=>{
        let combT = p.split("&&")
        let comb:string[] = []
        combT.forEach((c)=>{
            if(c != ""){
                comb.push(c.trim())
            }
        })
        if(comb.length != 0){
            tokens.push(comb);
        }
    })

    return tokens;
}


export function tokenSearch(input:string|any, tokens:string[][], keys:string[]|null = null){
    if(tokens.length == 0){
        return true;
    }
    if(keys){
        
    }else{
        input = { "text" : input };
        keys = ["text"];
    }

    let found = false;
    
    

    tokens.forEach((token:string[])=>{
        let combFound = true;
        token.forEach((comb)=>{
            let keyFound = false;
            keys.forEach((k)=>{
                // Fields can legitimately be missing (e.g. a flow without an
                // alias) — the old unguarded .search() threw, the caller's
                // try/catch swallowed it and the whole filter pass silently
                // aborted.
                let v = input[k];
                if(typeof v === "string" && v.search(new RegExp(comb, "i")) != -1){
                    keyFound = true
                }
            });
            if(!keyFound){
                combFound = false;
            }
        });

        if(combFound){
            found = true;
        }
    });

    return found;
}

/**
 * Split a label into a head that may be ellipsized and a tail that never is.
 * Rendered as two flex items (see .cp-mid in crosspoint.scss) the browser
 * shortens the MIDDLE: "Kamera Studio A Reih… 12" instead of
 * "Kamera Studio A R…" — which is the difference between telling twelve
 * identically named senders apart and not.
 *
 * The tail is the part that carries the distinction:
 *   trailing number with its separator  "Cam Studio A 12"   -> " 12"
 *   otherwise the last short word       "Pebble Video Main" -> "Main"
 *   otherwise the last four characters  "Langerstringohne"  -> "ohne"
 * Short labels keep an empty tail — nothing to protect there.
 */
export function midSplit(name:string):{head:string, tail:string}{
    let s = "" + (name === null || name === undefined ? "" : name);
    // Below this the label fits anyway, and a tail would only split a word.
    if(s.length <= 8){ return {head:s, tail:""}; }

    // A trailing number, with whatever separates it from the name.
    let m = s.match(/^(.*?)([\s._\-#/]?\d{1,6})$/);
    if(m && m[1].trim().length >= 2){ return {head:m[1], tail:m[2]}; }

    // Last word, as long as it is short enough to leave the head some room.
    let sp = s.lastIndexOf(" ");
    if(sp > 1 && s.length - sp - 1 > 0 && s.length - sp - 1 <= 8){
        return {head:s.slice(0, sp + 1), tail:s.slice(sp + 1)};
    }

    return {head:s.slice(0, -4), tail:s.slice(-4)};
}

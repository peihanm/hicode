// Fixed native read-only adapter. No paths, commands or pasteboard names come from model input.
export const MACOS_CLIPBOARD_IMAGE_SCRIPT = `
ObjC.import('AppKit');
function run() {
    const board = $.NSPasteboard.generalPasteboard;
    if (!board || typeof board.dataForType !== 'function') return JSON.stringify({kind: 'error'});
    const revision = Number(board.changeCount);
    const types = ObjC.deepUnwrap(board.types) || [];
    let data;
    if (types.indexOf('public.png') >= 0) {
        data = board.dataForType('public.png');
    } else if (types.indexOf('public.tiff') >= 0) {
        const tiff = board.dataForType('public.tiff');
        if (!tiff || Number(tiff.length) > 20 * 1024 * 1024) return JSON.stringify({kind: 'error'});
        const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
        if (!rep || Number(rep.pixelsWide) * Number(rep.pixelsHigh) > 40000000) return JSON.stringify({kind: 'error'});
        data = rep.representationUsingTypeProperties($.NSPNGFileType, $.NSDictionary.dictionary);
    } else return JSON.stringify({kind: 'empty'});
    if (!data || Number(data.length) < 1 || Number(data.length) > 20 * 1024 * 1024 || Number(board.changeCount) !== revision)
        return JSON.stringify({kind: 'error'});
    return JSON.stringify({kind: 'image', data: ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
}
`;

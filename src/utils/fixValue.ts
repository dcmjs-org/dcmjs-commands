export function fixValue(value) {
    if( !value?.Value ) {
        return;
    }
    if( value.vr==='CS' && value.Value?.length===1 ) {
        value.Value = value.Value[0].split('\\');
    }
}
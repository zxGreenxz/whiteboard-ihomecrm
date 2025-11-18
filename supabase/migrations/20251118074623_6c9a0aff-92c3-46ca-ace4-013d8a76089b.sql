-- Create ui-references bucket for storing UI design references
INSERT INTO storage.buckets (id, name, public)
VALUES ('ui-references', 'ui-references', true);

-- Policy: Allow everyone to view UI references (public read)
CREATE POLICY "Public can view UI references"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'ui-references');

-- Policy: Allow authenticated users to upload UI references
CREATE POLICY "Authenticated users can upload UI references"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'ui-references');

-- Policy: Allow users to delete their own uploads
CREATE POLICY "Users can delete own UI references"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'ui-references' AND auth.uid() = owner);
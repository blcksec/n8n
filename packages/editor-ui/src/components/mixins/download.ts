import Vue from 'vue';

export const download = Vue.extend({
	methods: {
		async downloadFile(url: string, fileName: string) {
			const iframe = document.createElement('iframe');
			iframe.src = url;
			iframe.style.display = 'none';
			document.body.appendChild(iframe);
			const iDocument = iframe.contentWindow!.document;
			iDocument.write('<body></body>');
			const link = iDocument.createElement('a');
			link.href = url;
			link.download = fileName;
			iDocument.body.appendChild(link);
			link.click();
			setTimeout(() => {
				document.body.removeChild(iframe);
			}, 5000);
		},
	},
});
